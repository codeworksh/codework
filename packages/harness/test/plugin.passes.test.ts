import "./utils/env.ts";
import { Effect, Option } from "effect";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { follow, load, type Pool } from "../src/plugin/catalog.ts";
import { Event } from "../src/event/event.ts";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { State } from "../src/state/state.ts";
import { define } from "../src/plugin/plugin.ts";
import type { Fetchable } from "../src/plugin/source.ts";
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
	it("drops a retained origin whose source vanished instead of failing the rebuild", async () => {
		const base = await Effect.runPromise(
			load(["a@1"], {
				...options,
				declared: new Map([["a@1", "/project-a/.codework/settings.jsonc"]]),
				install: () => Effect.succeed({ url: "virtual:a@1", generation: 1 }),
				import: () => Promise.resolve({ default: marker("acme.prompt.a") }),
			}),
		);
		// `a@1` was loaded for another session and its source is gone now -- a deleted file or a
		// removed store entry. It is nobody's declaration, so it leaves the pool with a warning
		// rather than failing `b`'s exchange.
		const moved = await Effect.runPromise(
			follow(
				["b"],
				base,
				{
					...options,
					declared: new Map([["b", "/project-b/.codework/settings.jsonc"]]),
					install: () => Effect.succeed({ url: "virtual:b@latest", generation: 1 }),
					import: () => Promise.resolve({ default: marker("acme.prompt.b") }),
				},
				(reference) => (reference === "b" ? Effect.succeedSome({ generation: 1 }) : Effect.succeedNone),
			),
		);
		const pool = Option.getOrThrow(moved);
		expect([...pool.plugins.keys()]).toEqual(["acme.prompt.b"]);
		expect([...pool.origins.keys()]).toEqual(["acme.prompt.b"]);
	});

	it("keeps other session modules while the current reference replaces an earlier spec", async () => {
		const first = marker("acme.prompt.a");
		const second = marker("acme.prompt.a");
		const other = marker("acme.prompt.b");
		const modules = new Map([
			["virtual:a@1", first],
			["virtual:a@2", second],
			["virtual:b@latest", other],
		]);
		const shared = {
			...options,
			install: (target: Fetchable) => Effect.succeed({ url: `virtual:${target.spec}`, generation: 1 }),
			import: (url: string) => Promise.resolve({ default: modules.get(url) }),
		};
		const base = await Effect.runPromise(load(["a@1", "b"], shared));
		const moved = await Effect.runPromise(follow(["a@2"], base, shared, () => Effect.succeedSome({ generation: 1 })));
		const pool = Option.getOrThrow(moved);

		expect([...pool.plugins.keys()].sort()).toEqual(["acme.prompt.a", "acme.prompt.b"]);
		expect(pool.plugins.get("acme.prompt.a")).toBe(second);
		expect(pool.aliases.has("b")).toBe(true);
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
});

describe("a running session and the store", () => {
	it("picks up a plugin added to settings mid-session, from the store, at the next exchange", () =>
		withProject(async ({ root, project }) => {
			const home = join(root, "home");
			const cache = join(home, "cache");
			// Publish a store entry by hand: `plugin install` is the verb that would normally do
			// this, and it is a separate process. What matters here is that an exchange finds it.
			const spec = "fixture-codework-plugin@1.0.0";
			const digest = createHash("sha256").update(`https://registry.npmjs.org/\0${spec}`).digest("hex");
			const entry = join(cache, "plugins", "v2", "fixture-codework-plugin", digest, "1000");
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
	it("fails on a user-layer plugin whose bytes are missing, rather than fetching it", () =>
		withProject(async ({ root, project }) => {
			// The user layer is the process's own selection: an entry it cannot resolve fails the
			// boot, never a fetch.
			await writeFile(
				join(root, "home", "settings.jsonc"),
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

	it("leaves a project-layer entry to its session -- boot does not see it", () =>
		withProject(async ({ root, project }) => {
			await writeFile(
				join(project, ".codework", "settings.jsonc"),
				JSON.stringify({ plugins: ["@acme/never-published-anywhere"] }),
			);

			// The process starts in the project but reads no project layer: boot succeeds, and the
			// entry is the session's drift report -- a warning at its exchange, not a startup
			// failure and never a fetch.
			const prompts: string[] = [];
			const open = immediateOpen();
			await Effect.runPromise(
				Effect.gen(function* () {
					const session = yield* Session.create({ directory: project, hostDir: project });
					yield* session.prompt({ text: "go", delivery: "followUp" });
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
			expect(prompts).toHaveLength(1);
		}));

	it("does not read a `.codework` found above the directory the process started in", () =>
		withProject(async ({ root, project }) => {
			// `project` holds the marker; the process launches from deep inside it, the way an
			// installed binary in /var/usr would. Its ancestors must not configure the process.
			const bin = join(project, "var", "usr", "bin");
			await mkdir(bin, { recursive: true });
			const sentinel = join(root, "imported.sentinel");
			const module = join(project, "marker.mjs");
			// A prompt marker alone would not prove the point: a boot that loaded the module into
			// the process pool would still leave it out of this session's selection. The import
			// side effect is the observation that matters -- if boot ever evaluates the module,
			// the sentinel exists.
			await writeFile(
				module,
				[
					`import { writeFileSync } from "node:fs";`,
					`writeFileSync(${JSON.stringify(sentinel)}, "loaded");`,
					"export default {",
					"  id: 'acme.prompt.marker',",
					"  kind: 'prompt',",
					"  setup: (ctx) => ctx.plugin.prompt.set(`${ctx.plugin.prompt.get() ?? ''}marker`),",
					"};",
				].join("\n"),
			);
			await writeFile(join(project, ".codework", "settings.jsonc"), JSON.stringify({ plugins: [module] }));

			// A session in a plain directory gets only the user layer: nothing of the startup
			// directory's project leaks into either the boot pool or the exchange.
			const plain = join(root, "plain");
			await mkdir(plain);
			const prompts: string[] = [];
			const open = immediateOpen();
			await Effect.runPromise(
				Effect.gen(function* () {
					const session = yield* Session.create({ directory: plain, hostDir: plain });
					yield* session.prompt({ text: "go", delivery: "followUp" });
					yield* session.resume();
					yield* session.wait();
				}).pipe(
					Effect.provide(
						Harness.layer({
							home: join(root, "home"),
							hostCwd: bin,
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
			expect(prompts).toHaveLength(1);
			expect(prompts[0]).not.toContain("marker");
			await expect(access(sentinel)).rejects.toThrow();
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
		readonly hostCwd?: string;
		readonly prompts: string[];
		readonly body: (
			state: State.Interface,
			run: () => Effect.Effect<void, unknown>,
		) => Effect.Effect<void, unknown, Event.Service>;
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
						hostCwd: input.hostCwd ?? input.project,
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

	it("reloads a local plugin discovered from a linked session outside the startup project", () =>
		withProject(async ({ root, project }) => {
			const elsewhere = join(root, "elsewhere");
			await mkdir(elsewhere, { recursive: true });
			const file = join(project, "edited.mjs");
			await write(file, "before");
			await writeFile(join(project, ".codework", "settings.jsonc"), JSON.stringify({ plugins: [file] }));

			const prompts: string[] = [];
			await session({
				root,
				project,
				hostCwd: elsewhere,
				prompts,
				body: (state, run) =>
					Effect.gen(function* () {
						yield* run();
						yield* Effect.promise(() => write(file, "after"));
						const reloaded = yield* state.reload;
						expect(reloaded.failure).toBeUndefined();
						yield* run();
					}),
			});
			expect(prompts.map((prompt) => (prompt.endsWith("after") ? "after" : "before"))).toEqual(["before", "after"]);
		}));

	it("rejects an event definition on reload that the boot registry would reject", () =>
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
						yield* Effect.promise(() =>
							writeFile(
								file,
								[
									"export default {",
									"  id: 'acme.prompt.edited',",
									"  kind: 'prompt',",
									"  events: [{ type: 'session.created' }],",
									"  setup: (ctx) => ctx.plugin.prompt.set(`${ctx.plugin.prompt.get() ?? ''}after`),",
									"};",
								].join("\n"),
							),
						);
						const reloaded = yield* state.reload;
						expect(reloaded.failure).toBeDefined();
						yield* run();
					}),
			});
			expect(prompts.at(-1)?.endsWith("before")).toBe(true);
		}));

	it("publishes a plugin.updated notice for each lifecycle transition", () =>
		withProject(async ({ root, project }) => {
			const file = join(project, "edited.mjs");
			const settings = join(project, ".codework", "settings.jsonc");
			await write(file, "before");
			await writeFile(settings, JSON.stringify({ plugins: [file] }));

			const prompts: string[] = [];
			await session({
				root,
				project,
				prompts,
				body: (state, run) =>
					Effect.gen(function* () {
						const seen: Array<{
							status?: string;
							id?: string;
							reference?: string;
							file?: string;
							sessionId?: string;
						}> = [];
						yield* (yield* Event.Service).listen((event) =>
							event.type === "plugin.updated"
								? Effect.sync(() => {
										seen.push(event.data as (typeof seen)[number]);
									})
								: Effect.void,
						);

						// A project plugin is not a boot plugin: it loads at the session's first
						// exchange, through `follow`'s union -- that is the `loaded` notice.
						yield* run();
						// The plugin leaves settings and its file is gone: the next rebuild drops the
						// retained origin rather than failing on it.
						yield* Effect.promise(() => writeFile(settings, JSON.stringify({ plugins: [] })));
						yield* Effect.promise(() => rm(file));
						yield* state.reload;
						// A process-level failure names no session: the broken entry sits in the user
						// layer, which is the only layer `reload` reads.
						const broken = join(project, "broken.mjs");
						yield* Effect.promise(() =>
							writeFile(join(root, "home", "settings.jsonc"), JSON.stringify({ plugins: [broken] })),
						);
						yield* Effect.promise(() => writeFile(broken, "export default { nope: true };"));
						yield* state.reload;
						// An exchange failure on a path the module registry has never seen names
						// the session that ran it.
						yield* Effect.promise(() => writeFile(settings, JSON.stringify({ plugins: [broken] })));
						yield* run().pipe(Effect.ignore);

						expect(seen.map((event) => event.status)).toEqual(["loaded", "dropped", "failed", "failed"]);
						expect(seen[0]).toMatchObject({ id: "acme.prompt.edited", reference: file, file: settings });
						expect(seen[1]).toMatchObject({ id: "acme.prompt.edited", reference: file, file: settings });
						expect(seen[2]?.sessionId).toBeUndefined();
						expect(seen[3]?.sessionId).toBeDefined();
					}),
			});
			// The first exchange's lazy load ran the plugin: its marker made the prompt.
			expect(prompts[0]?.endsWith("before")).toBe(true);
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
					// The key is absent rather than undefined, which is exactly why callers get to
					// ask the question by name instead of knowing that.
					expect((yield* created.info).hasHostLink).toBe(false);

					const run = () =>
						created
							.prompt({ text: "go", delivery: "followUp" })
							.pipe(Effect.andThen(created.resume()), Effect.andThen(created.wait()));
					yield* run();

					yield* Session.link({ sessionId: created.id, hostDir: project });
					expect(yield* created.info).toMatchObject({ hostDir: project, hasHostLink: true });

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
});
