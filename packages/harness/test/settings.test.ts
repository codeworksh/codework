import dedent from "dedent";
import { Effect, Layer } from "effect";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Global } from "../src/global.ts";
import { Settings, parse, paths } from "../src/settings/settings.ts";

import { withSettings } from "./fixtures/settings.ts";

describe("host settings loader", () => {
	it.each(["codework-acme-plugin", [123], [{}], [""]])(
		"rejects a plugins block that is not a string array: %j",
		async (plugins) => {
			const failure = await Effect.runPromise(
				parse("settings.jsonc", JSON.stringify({ plugins })).pipe(Effect.flip),
			);
			expect(failure).toMatchObject({ reason: "decode" });
			expect(failure.detail).toContain("plugins");
		},
	);

	it("accumulates plugin entries across layers, lowest priority first", () =>
		withSettings(async ({ root, global, local, custom }) => {
			const write = (path: string, plugins: ReadonlyArray<unknown>) => writeFile(path, JSON.stringify({ plugins }));
			const layer = Settings.layer({ cwd: root, userConfigDir: custom }).pipe(
				Layer.provide(Layer.succeed(Global.Service, Global.make({ home: global }))),
			);
			await Effect.runPromise(
				Effect.gen(function* () {
					const settings = yield* Settings.Service;
					expect((yield* settings.load).plugins).toEqual([]);
					// A user's plugins are the defaults a project builds on, so a project file adds
					// to them rather than standing in for them.
					yield* Effect.promise(() => write(join(global, "settings.jsonc"), ["codework-global-plugin"]));
					expect((yield* settings.load).plugins).toEqual(["codework-global-plugin"]);
					yield* Effect.promise(() => write(join(local, "settings.jsonc"), ["codework-local-plugin"]));
					expect((yield* settings.load).plugins).toEqual(["codework-global-plugin", "codework-local-plugin"]);
					// One file per layer: `codework.jsonc` is the project layer once it exists, and
					// `.codework/settings.jsonc` stops contributing.
					yield* Effect.promise(() => write(join(root, "codework.jsonc"), ["codework-acme-plugin"]));
					expect((yield* settings.load).plugins).toEqual(["codework-global-plugin", "codework-acme-plugin"]);
					yield* Effect.promise(() => write(join(custom, "settings.jsonc"), ["codework-custom-plugin"]));
					expect((yield* settings.load).plugins).toEqual([
						"codework-global-plugin",
						"codework-acme-plugin",
						"codework-custom-plugin",
					]);
					// A project drops an inherited plugin the same way it drops a built-in.
					yield* Effect.promise(() =>
						write(join(root, "codework.jsonc"), [{ package: "codework-global-plugin", enabled: false }]),
					);
					expect((yield* settings.load).plugins).toEqual([
						"codework-global-plugin",
						{ package: "codework-global-plugin", enabled: false },
						"codework-custom-plugin",
					]);
					// A layer that names no `plugins` key contributes nothing, and an empty array is
					// a layer that contributes nothing either -- neither erases what came before.
					yield* Effect.promise(() => writeFile(join(root, "codework.jsonc"), "{}"));
					expect((yield* settings.load).plugins).toEqual(["codework-global-plugin", "codework-custom-plugin"]);
				}).pipe(Effect.provide(layer)),
			);
		}));

	it("carries a plugin options block through decode and merge exactly as written", () =>
		withSettings(async ({ root, global, custom }) => {
			const layer = Settings.layer({ cwd: root, userConfigDir: custom }).pipe(
				Layer.provide(Layer.succeed(Global.Service, Global.make({ home: global }))),
			);
			// Everywhere else in the document a null means "absent". A plugin's block is opaque,
			// so a null inside it is a value, and the plugin -- not settings -- decides what it means.
			const entry = {
				plugin: "acme.tool.x",
				options: { endpoint: null, nested: { value: null, keep: 1 }, list: [1, null] },
			};
			await Effect.runPromise(
				Effect.gen(function* () {
					const settings = yield* Settings.Service;
					yield* Effect.promise(() =>
						writeFile(join(global, "settings.jsonc"), JSON.stringify({ plugins: [entry] })),
					);
					expect((yield* settings.load).plugins).toEqual([entry]);
					// And through a second layer, whose entries are appended to the first's.
					yield* Effect.promise(() =>
						writeFile(join(custom, "settings.jsonc"), JSON.stringify({ plugins: [entry] })),
					);
					expect((yield* settings.load).plugins).toEqual([entry, entry]);
				}).pipe(Effect.provide(layer)),
			);
		}));

	it("anchors relative plugin entries to the file that declared them", () =>
		withSettings(async ({ root, global, local }) => {
			const layer = Settings.layer({ cwd: root }).pipe(
				Layer.provide(Layer.succeed(Global.Service, Global.make({ home: global }))),
			);
			const entries = [
				"./plugins/one.ts",
				{ package: "../sibling/two.ts", options: { deep: true } },
				"codework-acme-plugin",
				{ plugin: "codework.tool.bash", enabled: false },
			];
			await Effect.runPromise(
				Effect.gen(function* () {
					const settings = yield* Settings.Service;
					yield* Effect.promise(() =>
						writeFile(join(global, "settings.jsonc"), JSON.stringify({ plugins: entries })),
					);
					expect((yield* settings.load).plugins).toEqual([
						join(global, "plugins/one.ts"),
						// A configuration entry anchors its `package`, so a relative path names the
						// same module in both spellings, and keeps the rest of the entry.
						{ package: join(root, "sibling/two.ts"), options: { deep: true } },
						// Package specs pass through untouched, and `plugin` is an ID, not a location.
						"codework-acme-plugin",
						{ plugin: "codework.tool.bash", enabled: false },
					]);
					// The project layer anchors to its own directory, which differs between the two
					// layouts, and its entries follow the user layer's rather than replacing them.
					const user = [
						join(global, "plugins/one.ts"),
						{ package: join(root, "sibling/two.ts"), options: { deep: true } },
						"codework-acme-plugin",
						{ plugin: "codework.tool.bash", enabled: false },
					];
					yield* Effect.promise(() =>
						writeFile(join(local, "settings.jsonc"), JSON.stringify({ plugins: ["./plugins/one.ts"] })),
					);
					expect((yield* settings.load).plugins).toEqual([...user, join(local, "plugins/one.ts")]);
					yield* Effect.promise(() =>
						writeFile(join(root, "codework.jsonc"), JSON.stringify({ plugins: ["./plugins/one.ts"] })),
					);
					expect((yield* settings.load).plugins).toEqual([...user, join(root, "plugins/one.ts")]);
				}).pipe(Effect.provide(layer)),
			);
		}));

	it("requires exactly one of `plugin` and `package` on a configuration entry", async () => {
		const decode = (entry: unknown) =>
			Effect.runPromise(parse("settings.jsonc", JSON.stringify({ plugins: [entry] })).pipe(Effect.result));
		// Naming a plugin two ways at once says two different things, and an entry naming it no
		// way at all says nothing; neither is quietly reinterpreted.
		for (const entry of [
			{ plugin: "acme.tool.x", package: "@acme/x" },
			{ options: { one: 1 } },
			{ plugin: "", options: {} },
			{ plugin: "acme.tool.x", enabled: "yes" },
		]) {
			expect((await decode(entry))._tag).toBe("Failure");
		}
		for (const entry of [
			"@acme/x@1.2.0",
			{ plugin: "acme.tool.x" },
			{ package: "@acme/x", enabled: false },
			{ package: "./plugins/local.ts", options: { one: 1 } },
		]) {
			expect((await decode(entry))._tag).toBe("Success");
		}
	});

	it("reads a settings file as JSONC: comments and a trailing comma are the format, not mistakes", async () => {
		const source = dedent`
			{
				// The model this project works against.
				"model": {
					"id": "gpt-5.6-luna", /* inline */
					"thinkingLevel": "low",
				},
				"plugins": [
					"./plugins/local.ts",
					// Configuration blocks keep their own values verbatim, comments around them and all.
					{ "package": "./plugins/local.ts", "options": { "endpoint": null } },
				],
			}
		`;
		const patch = await Effect.runPromise(parse("codework.jsonc", source));
		expect(patch.model).toMatchObject({ id: "gpt-5.6-luna", thinkingLevel: "low" });
		expect(patch.plugins).toEqual([
			"./plugins/local.ts",
			{ package: "./plugins/local.ts", options: { endpoint: null } },
		]);
	});

	it("reports syntax locations and decode paths without exposing values", async () => {
		const malformed = '{\n"model": {"options": {"timeoutMs": 2,, "secret": "do-not-print"}}}';
		const syntax = await Effect.runPromise(parse("broken.json", malformed).pipe(Effect.flip));
		expect(syntax).toMatchObject({ path: "broken.json", reason: "parse" });
		// The parser names what it expected and where, which a hand-written file needs.
		expect(syntax.detail).toMatch(/^PropertyNameExpected at 2:\d+$/);
		expect(syntax.detail).not.toContain("do-not-print");
		const invalid = await Effect.runPromise(
			parse("invalid.json", '{"model":{"options":{"timeoutMs":"do-not-print"}}}').pipe(Effect.flip),
		);
		expect(invalid.detail).toContain("model.options.timeoutMs");
		expect(invalid.detail).not.toContain("do-not-print");
	});

	it("fails on a layer it cannot read", () =>
		withSettings(async ({ root, local, global, custom }) => {
			await mkdir(join(global, "settings.jsonc"));
			await writeFile(join(local, "settings.jsonc"), JSON.stringify({ model: { thinkingLevel: "max" } }));
			await writeFile(join(custom, "settings.jsonc"), JSON.stringify({ model: { options: { maxRetries: 4 } } }));
			const layer = Settings.layer({ cwd: root, userConfigDir: custom }).pipe(
				Layer.provide(Layer.succeed(Global.Service, Global.make({ home: join(root, "home") }))),
			);
			// A path that exists and cannot be read is the user's to fix, not a layer to skip.
			const error = await Effect.runPromise(
				Settings.Service.use((settings) => settings.load).pipe(Effect.provide(layer), Effect.flip),
			);
			expect(error).toMatchObject({ path: join(global, "settings.jsonc"), reason: "read" });
		}));

	it("lists both spellings per layout, searching up the directory chain", () => {
		const [user, project, custom] = paths("/home", "/repo/packages/app", "relative");
		// `.jsonc` is the canonical name and is tried first; `.json` still resolves.
		expect(user).toEqual(["/home/settings.jsonc", "/home/settings.json"]);
		expect(custom).toEqual([
			"/repo/packages/app/relative/settings.jsonc",
			"/repo/packages/app/relative/settings.json",
		]);
		// The project layer searches the startup directory, then its ancestors, nearest first, so
		// a command run inside a package reads the repository's own file.
		expect(project?.slice(0, 5)).toEqual([
			"/repo/packages/app/codework.jsonc",
			"/repo/packages/app/codework.json",
			"/repo/packages/app/.codework/settings.jsonc",
			"/repo/packages/app/.codework/settings.json",
			"/repo/packages/codework.jsonc",
		]);
		expect(project?.slice(-1)).toEqual(["/.codework/settings.json"]);
		expect(paths("/home", "/startup", "~/custom").at(-1)?.[0]).toBe(join(homedir(), "custom/settings.jsonc"));

		const [global, beneathHome] = paths("/users/me/.codework", "/users/me/project");
		expect(beneathHome).not.toContain(global?.[0]);
		expect(beneathHome).not.toContain(global?.[1]);
	});

	it("loads the project .json fallback and prefers .jsonc when both exist", () =>
		withSettings(async ({ root, custom }) => {
			await writeFile(join(root, "codework.json"), JSON.stringify({ model: { thinkingLevel: "low" } }));
			const layer = Settings.layer({ cwd: root, userConfigDir: custom }).pipe(
				Layer.provide(Layer.succeed(Global.Service, Global.make({ home: join(root, "home") }))),
			);
			await Effect.runPromise(
				Effect.gen(function* () {
					const settings = yield* Settings.Service;
					expect((yield* settings.load).model.thinkingLevel).toBe("low");
					yield* Effect.promise(() =>
						writeFile(join(root, "codework.jsonc"), JSON.stringify({ model: { thinkingLevel: "max" } })),
					);
					expect((yield* settings.load).model.thinkingLevel).toBe("max");
				}).pipe(Effect.provide(layer)),
			);
		}));

	it("prefers codework.json over .codework/settings.json when both exist", () =>
		withSettings(async ({ root, local, custom }) => {
			await writeFile(
				join(root, "codework.jsonc"),
				JSON.stringify({ model: { thinkingLevel: "max", options: { maxRetries: 2 } } }),
			);
			await writeFile(
				join(local, "settings.jsonc"),
				JSON.stringify({ model: { thinkingLevel: "low", options: { maxRetries: 9, timeoutMs: 123 } } }),
			);
			const layer = Settings.layer({ cwd: root, userConfigDir: custom }).pipe(
				Layer.provide(Layer.succeed(Global.Service, Global.make({ home: join(root, "home") }))),
			);
			const result = await Effect.runPromise(
				Settings.Service.use((settings) => settings.load).pipe(Effect.provide(layer)),
			);
			// The directory file is never consulted, so none of its values leak through.
			expect(result.model.thinkingLevel).toBe("max");
			expect(result.model.options?.maxRetries).toBe(2);
			expect(result.model.options?.timeoutMs).toBe(Settings.defaults.model.options?.timeoutMs);
		}));

	it("loads global and custom .json fallbacks while ignoring global codework.json", () =>
		withSettings(async ({ root, global, custom }) => {
			await writeFile(
				join(global, "codework.jsonc"),
				JSON.stringify({ model: { options: { headers: { excluded: "yes" } } } }),
			);
			await writeFile(
				join(global, "settings.json"),
				JSON.stringify({ model: { thinkingLevel: "low", options: { maxRetries: 2, timeoutMs: 100 } } }),
			);
			await writeFile(
				join(root, "codework.jsonc"),
				JSON.stringify({ model: { thinkingLevel: "high", options: { timeoutMs: 200 } } }),
			);
			await writeFile(join(custom, "settings.json"), JSON.stringify({ model: { thinkingLevel: "max" } }));
			const layer = Settings.layer({ cwd: root, userConfigDir: custom }).pipe(
				Layer.provide(Layer.succeed(Global.Service, Global.make({ home: global }))),
			);
			const result = await Effect.runPromise(
				Settings.Service.use((settings) => settings.load).pipe(Effect.provide(layer)),
			);
			expect(result.model).toMatchObject({
				thinkingLevel: "max",
				options: { maxRetries: 2, timeoutMs: 200 },
			});
			expect(result.model.options?.headers).toEqual(Settings.defaults.model.options?.headers);
		}));

	it("falls back to .codework/settings.json only when the root project file is missing", () =>
		withSettings(async ({ root, local, custom }) => {
			await writeFile(join(local, "settings.json"), JSON.stringify({ model: { thinkingLevel: "low" } }));
			const layer = Settings.layer({ cwd: root, userConfigDir: custom }).pipe(
				Layer.provide(Layer.succeed(Global.Service, Global.make({ home: join(root, "home") }))),
			);
			await Effect.runPromise(
				Effect.gen(function* () {
					const settings = yield* Settings.Service;
					expect((yield* settings.load).model.thinkingLevel).toBe("low");
					yield* Effect.promise(() =>
						writeFile(join(root, "codework.jsonc"), JSON.stringify({ model: { thinkingLevel: "max" } })),
					);
					expect((yield* settings.load).model.thinkingLevel).toBe("max");
					yield* Effect.promise(() => unlink(join(root, "codework.jsonc")));
					expect((yield* settings.load).model.thinkingLevel).toBe("low");
				}).pipe(Effect.provide(layer)),
			);
		}));

	it("fails on a malformed codework.json rather than falling back to the directory file", () =>
		withSettings(async ({ root, local, custom }) => {
			await writeFile(join(root, "codework.jsonc"), '{"model":');
			await writeFile(join(local, "settings.jsonc"), JSON.stringify({ model: { thinkingLevel: "low" } }));
			const layer = Settings.layer({ cwd: root, userConfigDir: custom }).pipe(
				Layer.provide(Layer.succeed(Global.Service, Global.make({ home: join(root, "home") }))),
			);
			// Skipping the layer would silently run this session on `.codework/settings.jsonc`, which
			// is a different configuration than the one the project committed.
			const error = await Effect.runPromise(
				Settings.Service.use((settings) => settings.load).pipe(Effect.provide(layer), Effect.flip),
			);
			expect(error).toMatchObject({ path: join(root, "codework.jsonc"), reason: "parse" });
			expect(error.detail).toMatch(/^ValueExpected at 1:\d+$/);
		}));

	it("loads fresh files for each exchange with no shared cache or mutations", () =>
		withSettings(async ({ root, local, global, custom }) => {
			const write = (dir: string, model: object) =>
				writeFile(join(dir, "settings.jsonc"), JSON.stringify({ model }));
			const layer = Settings.layer({ cwd: root, userConfigDir: "custom" }).pipe(
				Layer.provide(Layer.succeed(Global.Service, Global.make({ home: join(root, "home") }))),
			);
			await Effect.runPromise(
				Effect.gen(function* () {
					const settings = yield* Settings.Service;
					expect(yield* settings.load).toEqual(Settings.defaults);
					yield* Effect.promise(() => write(global, { options: { timeoutMs: 100, headers: { global: "yes" } } }));
					yield* Effect.promise(() => write(local, { options: { timeoutMs: 200, headers: { local: "yes" } } }));
					yield* Effect.promise(() => write(custom, { thinkingLevel: "low", options: { timeoutMs: 300 } }));
					const first = yield* settings.load;
					expect(first.model).toMatchObject({
						thinkingLevel: "low",
						options: { timeoutMs: 300, headers: { global: "yes", local: "yes" } },
					});
					yield* Effect.promise(() => write(custom, { thinkingLevel: "off", options: { timeoutMs: null } }));
					const second = yield* settings.load;
					expect(second.model).toMatchObject({ thinkingLevel: "off", options: { timeoutMs: 200 } });
					expect(first.model.thinkingLevel).toBe("low");
					yield* Effect.promise(() => unlink(join(custom, "settings.jsonc")));
					expect((yield* settings.load).model.thinkingLevel).toBe("high");
					// An edit that breaks a file reaches the next capture like any other edit. A broken
					// middle layer fails the load rather than handing the session to the layers
					// around it, which would run it on a configuration nobody wrote.
					yield* Effect.promise(() => writeFile(join(local, "settings.jsonc"), '{"model":'));
					yield* Effect.promise(() => write(custom, { thinkingLevel: "medium" }));
					const broken = yield* settings.load.pipe(Effect.flip);
					expect(broken).toMatchObject({ path: join(local, "settings.jsonc"), reason: "parse" });
					// Repaired, the next capture reads it, and an invalid value names the key it is on.
					yield* Effect.promise(() => write(local, { options: { timeoutMs: 200 } }));
					expect((yield* settings.load).model).toMatchObject({
						thinkingLevel: "medium",
						options: { timeoutMs: 200 },
					});
					yield* Effect.promise(() => write(custom, { options: { timeoutMs: "wrong" } }));
					const invalid = yield* settings.load.pipe(Effect.flip);
					expect(invalid).toMatchObject({ reason: "decode" });
					expect(invalid.detail).toContain("model.options.timeoutMs");
				}).pipe(Effect.provide(layer)),
			);
		}));
});
