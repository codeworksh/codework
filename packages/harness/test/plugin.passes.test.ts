import "./utils/env.ts";
import { Effect, Option } from "effect";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { follow, load, select, type PluginRef, type Pool } from "../src/plugin/catalog.ts";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { State } from "../src/state/state.ts";
import { define } from "../src/plugin/plugin.ts";
import { immediateOpen } from "./fixtures/llm.ts";

/*
 * The split: loading a module costs a store lookup and an ESM import, so it happens at boot and at
 * reload; configuring one is pure data over modules already in memory, so it happens every
 * exchange. These tests pin which side of that line each kind of edit falls on.
 */

const marker = (id: string) =>
	define({
		id,
		kind: "prompt",
		setup: (ctx, options) => {
			const suffix = typeof options.marker === "string" ? options.marker : "none";
			ctx.plugin.prompt.set(`${ctx.plugin.prompt.get() ?? ""}${suffix}`);
		},
	});

const options = { builtins: [], cache: "/unused", hostDir: "/project" };

/**
 * A resolve-only installer, which is all `follow` may ever be given: it answers from what is
 * already filed and can never reach a registry.
 */
const filedAt = (generation: number) => ({
	...options,
	install: () => Effect.succeed({ url: "file:///filed.js", generation }),
});

describe("the two passes", () => {
	it("loads a module once however many entries name it", async () => {
		const plugin = marker("acme.prompt.one");
		const pool = await Effect.runPromise(load([plugin, plugin, { plugin: plugin.id }], options));
		expect(pool.plugins.size).toBe(1);
	});

	it("configures without loading: enabled, options and order are pure data", async () => {
		const first = marker("acme.prompt.first");
		const second = marker("acme.prompt.second");
		const pool = await Effect.runPromise(load([first, second], options));

		const walk = (references: ReadonlyArray<PluginRef>) => Effect.runPromise(select(references, pool));

		// Order follows where an entry was written.
		expect((await walk([first, second])).selection.map((entry) => entry.plugin.id)).toEqual([first.id, second.id]);
		expect((await walk([second, first])).selection.map((entry) => entry.plugin.id)).toEqual([second.id, first.id]);
		// `enabled: false` drops one without unloading it.
		expect(
			(await walk([first, second, { plugin: second.id, enabled: false }])).selection.map((entry) => entry.plugin.id),
		).toEqual([first.id]);
		// The module stays in the pool either way: dropping a plugin entry is configuration.
		expect(pool.plugins.has(second.id)).toBe(true);
		// Options are opaque, so the last block written owns it whole.
		expect(
			(
				await walk([
					first,
					{ plugin: first.id, options: { marker: "a" } },
					{ plugin: first.id, options: { marker: "b" } },
				])
			).selection[0]?.options,
		).toEqual({ marker: "b" });
	});

	it("reports an entry naming a module it does not hold, rather than fetching it", async () => {
		const pool = await Effect.runPromise(load([], options));
		const walked = await Effect.runPromise(select(["@acme/never-installed"], pool));
		// The one case the config pass cannot satisfy, which is what makes drift free to report.
		expect(walked.missing).toEqual(["@acme/never-installed"]);
		expect(walked.selection).toEqual([]);
	});

	it("configures a built-in through the same path as anything else", async () => {
		const builtin = marker("codework.prompt.builtin");
		const pool = await Effect.runPromise(load([], { ...options, builtins: [builtin] }));
		expect(pool.plugins.has(builtin.id)).toBe(true);
		// Seeded but not selected: naming it is what selects it.
		expect((await Effect.runPromise(select([], pool))).selection).toEqual([]);
		expect(
			(await Effect.runPromise(select([builtin.id, { plugin: builtin.id, enabled: false }], pool))).selection,
		).toEqual([]);
		expect((await Effect.runPromise(select([builtin.id], pool))).selection).toHaveLength(1);
	});
});

const withProject = async (body: (dirs: { root: string; project: string }) => Promise<void>) => {
	const root = await mkdtemp(join(tmpdir(), "plugin-passes-"));
	const project = join(root, "project");
	await mkdir(join(project, ".codework"), { recursive: true });
	await mkdir(join(root, "home"), { recursive: true });
	try {
		await body({ root, project });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
};

describe("a running session", () => {
	it("picks up an options edit at the next exchange, without re-importing anything", () =>
		withProject(async ({ root, project }) => {
			// A real module on disk, so the plugin arrives through settings rather than through an
			// embedder's list -- which is the path an `options` edit has to travel.
			const module = join(project, "marker.mjs");
			let imports = 0;
			await writeFile(
				module,
				[
					"globalThis.__markerImports = (globalThis.__markerImports ?? 0) + 1;",
					"export default {",
					"  id: 'acme.prompt.live',",
					"  kind: 'prompt',",
					"  setup: (ctx, options) => ctx.plugin.prompt.set(`${ctx.plugin.prompt.get() ?? ''}${options.marker}`),",
					"};",
				].join("\n"),
			);
			const file = join(project, ".codework", "settings.jsonc");
			const write = (value: string) =>
				writeFile(
					file,
					JSON.stringify({ plugins: [module, { plugin: "acme.prompt.live", options: { marker: value } }] }),
				);
			await write("before");

			const prompts: string[] = [];
			const open = immediateOpen();
			await Effect.runPromise(
				Effect.gen(function* () {
					const session = yield* Session.create({ directory: project, hostDir: project });
					// `prompt` admits, `resume` drains, `wait` blocks until the exchange is done --
					// which this test needs, so the edit lands strictly between two of them.
					yield* session.prompt({ text: "one", delivery: "followUp" });
					yield* session.resume();
					yield* session.wait();

					yield* Effect.promise(() => write("after"));
					imports = (globalThis as { __markerImports?: number }).__markerImports ?? 0;

					// No reload and no re-import: the module was already in memory, and only the
					// data around it changed.
					yield* session.prompt({ text: "two", delivery: "followUp" });
					yield* session.resume();
					yield* session.wait();
				}).pipe(
					Effect.provide(
						Harness.layer({
							home: join(root, "home"),
							hostCwd: project,
							database: ":memory:",
							llm: (request, signal) => {
								prompts.push(request.context.systemPrompt ?? "");
								return open(request, signal);
							},
						}),
					),
					Effect.scoped,
					Effect.timeout("20 seconds"),
					Effect.orDie,
				),
			);
			expect(prompts[0]?.endsWith("before")).toBe(true);
			expect(prompts[1]?.endsWith("after")).toBe(true);
			// The module was imported once, at boot, and never again.
			expect((globalThis as { __markerImports?: number }).__markerImports).toBe(imports);
		}));
});

describe("following the store at an exchange boundary", () => {
	it("does nothing when the store has not moved", async () => {
		const first = marker("acme.prompt.a");
		const base = await Effect.runPromise(load([first], options));
		// Filed at the generation it was loaded at, so there is nothing to follow.
		const moved = await Effect.runPromise(follow([first], base, filedAt(1), () => Effect.succeedNone));
		expect(Option.isNone(moved)).toBe(true);
	});

	it("loads an entry the store holds but the pool does not", async () => {
		const base = await Effect.runPromise(load([], options));
		const arrived = {
			...filedAt(1),
			import: () => Promise.resolve({ default: marker("acme.prompt.new") }),
		};
		const moved = await Effect.runPromise(
			// Configured, not loaded, and the bytes are already here: exactly the case the
			// exchange boundary settles without anyone asking.
			follow(["@acme/new"], base, arrived, () => Effect.succeedSome({ generation: 1 })),
		);
		expect(Option.isSome(moved)).toBe(true);
		expect(Option.getOrThrow(moved).plugins.has("acme.prompt.new")).toBe(true);
	});

	it("leaves an entry the store does not hold, rather than fetching it", async () => {
		const base = await Effect.runPromise(load([], options));
		// Not filed, so nothing to follow. Reported by the config pass, never fetched here: an
		// exchange must not be able to block on a registry.
		const moved = await Effect.runPromise(
			follow(["@acme/never-installed"], base, filedAt(1), () => Effect.succeedNone),
		);
		expect(Option.isNone(moved)).toBe(true);
	});

	it("follows a newer generation of a module it already holds", async () => {
		// A pool that believes it is on generation 1.
		const base: Pool = {
			plugins: new Map([["acme.prompt.moved", marker("acme.prompt.moved")]]),
			aliases: new Map([["@acme/moved", "acme.prompt.moved"]]),
			versions: new Map(),
			origins: new Map([["acme.prompt.moved", { reference: "@acme/moved", generation: 1 }]]),
		};
		const replacement = marker("acme.prompt.moved");
		const reloaded = {
			...filedAt(2),
			import: () => Promise.resolve({ default: replacement }),
		};

		// Same generation: `plugin update` found nothing, so neither does this.
		expect(
			Option.isNone(
				await Effect.runPromise(
					follow(["@acme/moved"], base, reloaded, () => Effect.succeedSome({ generation: 1 })),
				),
			),
		).toBe(true);

		// Newer generation. Without this check the question is "is this entry loaded?", the answer
		// after an update is still yes, and the bytes just fetched would sit on disk unused.
		const moved = await Effect.runPromise(
			follow(["@acme/moved"], base, reloaded, () => Effect.succeedSome({ generation: 2 })),
		);
		expect(Option.isSome(moved)).toBe(true);
		expect(Option.getOrThrow(moved).origins.get("acme.prompt.moved")?.generation).toBe(2);
	});

	it("never follows a local source, which has no generation to compare", async () => {
		const base: Pool = {
			plugins: new Map([["acme.prompt.local", marker("acme.prompt.local")]]),
			aliases: new Map([["./local.ts", "acme.prompt.local"]]),
			versions: new Map(),
			// A local plugin is never copied into the store, so it has no generation at all --
			// which is why `plugin reload` exists and is the only thing that covers it.
			origins: new Map([["acme.prompt.local", { reference: "./local.ts" }]]),
		};
		const moved = await Effect.runPromise(
			follow(["./local.ts"], base, filedAt(99), () => Effect.succeedSome({ generation: 99 })),
		);
		expect(Option.isNone(moved)).toBe(true);
	});
});

describe("a running session and the store", () => {
	it("picks up a plugin added to settings mid-session, from the store, at the next exchange", () =>
		withProject(async ({ root, project }) => {
			const home = join(root, "home");
			const cache = join(home, "cache");
			// Publish a store entry by hand: `plugin install` is the verb that would normally do
			// this, and it is a separate process. What matters here is that an exchange finds it.
			const spec = "fixture-codework-plugin@1.0.0";
			const digest = createHash("sha256").update(spec).digest("hex");
			const entry = join(cache, "plugins", "v1", "fixture-codework-plugin", digest, "1000");
			await mkdir(entry, { recursive: true });
			await writeFile(
				join(entry, "index.mjs"),
				[
					"export default {",
					"  id: 'acme.prompt.arrived',",
					"  kind: 'prompt',",
					"  setup: (ctx) => ctx.plugin.prompt.set(`${ctx.plugin.prompt.get() ?? ''}arrived`),",
					"};",
				].join("\n"),
			);
			await writeFile(
				join(entry, ".complete.json"),
				JSON.stringify({
					spec,
					name: "fixture-codework-plugin",
					version: "1.0.0",
					entrypoint: "index.mjs",
					createdAt: 1000,
				}),
			);

			const file = join(project, ".codework", "settings.jsonc");
			await writeFile(file, JSON.stringify({ plugins: [] }));

			const prompts: string[] = [];
			const open = immediateOpen();
			await Effect.runPromise(
				Effect.gen(function* () {
					const session = yield* Session.create({ directory: project, hostDir: project });
					yield* session.prompt({ text: "one", delivery: "followUp" });
					yield* session.resume();
					yield* session.wait();

					// The entry appears in settings between exchanges. Its bytes are already on
					// disk, so nothing has to be fetched -- and nothing was watching.
					yield* Effect.promise(() => writeFile(file, JSON.stringify({ plugins: [spec] })));

					yield* session.prompt({ text: "two", delivery: "followUp" });
					yield* session.resume();
					yield* session.wait();
				}).pipe(
					Effect.provide(
						Harness.layer({
							home,
							hostCwd: project,
							database: ":memory:",
							llm: (request, signal) => {
								prompts.push(request.context.systemPrompt ?? "");
								return open(request, signal);
							},
						}),
					),
					Effect.scoped,
					Effect.timeout("20 seconds"),
					Effect.orDie,
				),
			);
			expect(prompts).toHaveLength(2);
			expect(prompts[0]).not.toContain("arrived");
			expect(prompts[1]?.endsWith("arrived")).toBe(true);
		}));
});

describe("boot", () => {
	it("reports a configured plugin whose bytes are missing, rather than fetching it", () =>
		withProject(async ({ root, project }) => {
			await writeFile(
				join(project, ".codework", "settings.jsonc"),
				JSON.stringify({ plugins: ["@acme/never-published-anywhere"] }),
			);

			const failure = await Effect.runPromise(
				Effect.gen(function* () {
					yield* Session.create({ directory: project, hostDir: project });
				}).pipe(
					Effect.provide(Harness.layer({ home: join(root, "home"), hostCwd: project, database: ":memory:" })),
					Effect.scoped,
					Effect.flip,
					Effect.timeout("20 seconds"),
					Effect.orDie,
				),
			);

			// Not a registry round-trip: a start that fetches can wait on the network, fail
			// offline, and let network timing decide which code runs. `plugin install` is the verb
			// that puts bytes on disk, and this is the error that names it.
			expect(failure).toMatchObject({ _tag: "PluginStoreError", reason: "plugin-not-installed" });
		}));
});

describe("reload", () => {
	/** A local plugin whose contents change while its path does not. */
	const write = (file: string, suffix: string) =>
		writeFile(
			file,
			[
				"export default {",
				"  id: 'acme.prompt.edited',",
				"  kind: 'prompt',",
				`  setup: (ctx) => ctx.plugin.prompt.set(\`\${ctx.plugin.prompt.get() ?? ''}${suffix}\`),`,
				"};",
			].join("\n"),
		);

	const session = (input: {
		readonly root: string;
		readonly project: string;
		readonly prompts: string[];
		readonly body: (state: State.Interface, run: () => Effect.Effect<void, unknown>) => Effect.Effect<void, unknown>;
	}) => {
		const open = immediateOpen();
		return Effect.runPromise(
			Effect.gen(function* () {
				const created = yield* Session.create({ directory: input.project, hostDir: input.project });
				const state = yield* State.Service;
				const run = () =>
					created
						.prompt({ text: "go", delivery: "followUp" })
						.pipe(Effect.andThen(created.resume()), Effect.andThen(created.wait()), Effect.asVoid);
				yield* input.body(state, run);
			}).pipe(
				Effect.provide(
					Harness.layer({
						home: join(input.root, "home"),
						hostCwd: input.project,
						database: ":memory:",
						llm: (request, signal) => {
							input.prompts.push(request.context.systemPrompt ?? "");
							return open(request, signal);
						},
					}),
				),
				Effect.scoped,
				Effect.timeout("20 seconds"),
				Effect.orDie,
			) as Effect.Effect<void>,
		);
	};

	it("re-imports a local plugin edited in place, which nothing else can notice", () =>
		withProject(async ({ root, project }) => {
			const file = join(project, "edited.mjs");
			await write(file, "before");
			await writeFile(join(project, ".codework", "settings.jsonc"), JSON.stringify({ plugins: [file] }));

			const prompts: string[] = [];
			await session({
				root,
				project,
				prompts,
				body: (state, run) =>
					Effect.gen(function* () {
						yield* run();
						// Same path, same settings, no generation -- a local source is never filed,
						// so neither exchange-boundary check can fire. Without the cache-buster the
						// module registry hands back the module it already has.
						yield* Effect.promise(() => write(file, "after"));
						yield* run();
						expect(prompts[1]?.endsWith("before")).toBe(true);

						const reloaded = yield* state.reload;
						expect(reloaded.failure).toBeUndefined();
						yield* run();
					}),
			});
			// Two exchanges see the old module against an unchanged URL; the reload is what makes
			// the third see the edit.
			expect(prompts.map((prompt) => (prompt.endsWith("after") ? "after" : "before"))).toEqual([
				"before",
				"before",
				"after",
			]);
		}));

	it("keeps the last good set when a reload fails, rather than emptying the registry", () =>
		withProject(async ({ root, project }) => {
			const file = join(project, "edited.mjs");
			await write(file, "before");
			await writeFile(join(project, ".codework", "settings.jsonc"), JSON.stringify({ plugins: [file] }));

			const prompts: string[] = [];
			await session({
				root,
				project,
				prompts,
				body: (state, run) =>
					Effect.gen(function* () {
						yield* run();
						// Broken in a way only an import can discover.
						yield* Effect.promise(() => writeFile(file, "export default { nope: true };"));

						const reloaded = yield* state.reload;
						expect(reloaded.failure).toBeDefined();
						expect(reloaded.plugins).toBeGreaterThan(0);

						// A server that emptied its tool registry over a typo would be worse than
						// one that keeps working and says so, so the previous set is still live.
						yield* run();
					}),
			});
			expect(prompts.at(-1)?.endsWith("before")).toBe(true);
		}));
});

describe("linking a session to a host directory", () => {
	it("starts reading the project's plugins at the next exchange", () =>
		withProject(async ({ root, project }) => {
			// A plugin the project declares, which nothing has any reason to load yet.
			const module = join(project, "linked.mjs");
			await writeFile(
				module,
				[
					"export default {",
					"  id: 'acme.prompt.linked',",
					"  kind: 'prompt',",
					"  setup: (ctx) => ctx.plugin.prompt.set(`${ctx.plugin.prompt.get() ?? ''}linked`),",
					"};",
				].join("\n"),
			);
			await writeFile(join(project, ".codework", "settings.jsonc"), JSON.stringify({ plugins: [module] }));

			// The process boots somewhere else entirely, so the project is not its own.
			const elsewhere = join(root, "elsewhere");
			await mkdir(elsewhere, { recursive: true });

			const prompts: string[] = [];
			const open = immediateOpen();
			await Effect.runPromise(
				Effect.gen(function* () {
					// No host directory: this session has no project layer, which is a normal
					// state rather than a missing value.
					const created = yield* Session.create({ directory: project });
					expect((yield* created.info).hostDir).toBeUndefined();

					const run = () =>
						created
							.prompt({ text: "go", delivery: "followUp" })
							.pipe(Effect.andThen(created.resume()), Effect.andThen(created.wait()));
					yield* run();

					yield* Session.link({ sessionId: created.id, hostDir: project });
					expect((yield* created.info).hostDir).toBe(project);

					// Settings are re-read every exchange, so the project layer simply starts
					// being read -- and its plugin is local, so its bytes were always here.
					yield* run();
				}).pipe(
					Effect.provide(
						Harness.layer({
							home: join(root, "home"),
							hostCwd: elsewhere,
							database: ":memory:",
							llm: (request, signal) => {
								prompts.push(request.context.systemPrompt ?? "");
								return open(request, signal);
							},
						}),
					),
					Effect.scoped,
					Effect.timeout("20 seconds"),
					Effect.orDie,
				),
			);

			expect(prompts).toHaveLength(2);
			expect(prompts[0]).not.toContain("linked");
			expect(prompts[1]?.endsWith("linked")).toBe(true);
		}));

	it("returns a session to the user layer when unlinked", () =>
		withProject(async ({ root, project }) => {
			const module = join(project, "linked.mjs");
			await writeFile(
				module,
				[
					"export default {",
					"  id: 'acme.prompt.linked',",
					"  kind: 'prompt',",
					"  setup: (ctx) => ctx.plugin.prompt.set(`${ctx.plugin.prompt.get() ?? ''}linked`),",
					"};",
				].join("\n"),
			);
			await writeFile(join(project, ".codework", "settings.jsonc"), JSON.stringify({ plugins: [module] }));

			const prompts: string[] = [];
			const open = immediateOpen();
			await Effect.runPromise(
				Effect.gen(function* () {
					const created = yield* Session.create({ directory: project, hostDir: project });
					const run = () =>
						created
							.prompt({ text: "go", delivery: "followUp" })
							.pipe(Effect.andThen(created.resume()), Effect.andThen(created.wait()));
					yield* run();

					yield* Session.link({ sessionId: created.id, hostDir: null });
					expect((yield* created.info).hostDir).toBeUndefined();
					// The module stays loaded in the pool; it is simply no longer selected, which
					// is the config pass doing its job rather than anything being unloaded.
					yield* run();
				}).pipe(
					Effect.provide(
						Harness.layer({
							home: join(root, "home"),
							hostCwd: project,
							database: ":memory:",
							llm: (request, signal) => {
								prompts.push(request.context.systemPrompt ?? "");
								return open(request, signal);
							},
						}),
					),
					Effect.scoped,
					Effect.timeout("20 seconds"),
					Effect.orDie,
				),
			);

			expect(prompts[0]?.endsWith("linked")).toBe(true);
			expect(prompts[1]).not.toContain("linked");
		}));
});
