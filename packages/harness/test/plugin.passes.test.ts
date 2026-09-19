import "./utils/env.ts";
import { Effect } from "effect";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { load, select, type PluginRef } from "../src/plugin/catalog.ts";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
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
