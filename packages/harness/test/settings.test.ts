import dedent from "dedent";
import { Effect, Layer } from "effect";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Global } from "../src/global.ts";
import { Settings, parse, paths, userConfigDir } from "../src/settings/settings.ts";

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
		withSettings(async ({ root, global, local }) => {
			const write = (path: string, plugins: ReadonlyArray<unknown>) => writeFile(path, JSON.stringify({ plugins }));
			const layer = Settings.layer({}).pipe(
				Layer.provide(Layer.succeed(Global.Service, Global.make({ home: global }))),
			);
			await Effect.runPromise(
				Effect.gen(function* () {
					const settings = yield* Settings.Service;
					expect((yield* settings.load(root)).plugins).toEqual([]);
					// A user's plugins are the defaults a project builds on, so a project file adds
					// to them rather than standing in for them.
					yield* Effect.promise(() => write(join(global, "settings.jsonc"), ["codework-global-plugin"]));
					expect((yield* settings.load(root)).plugins).toEqual(["codework-global-plugin"]);
					yield* Effect.promise(() => write(join(local, "settings.jsonc"), ["codework-local-plugin"]));
					expect((yield* settings.load(root)).plugins).toEqual([
						"codework-global-plugin",
						"codework-local-plugin",
					]);
					// One file per layer: the project contributes `.codework/settings.jsonc` and
					// nothing else, so rewriting it replaces what the project declared.
					yield* Effect.promise(() => write(join(local, "settings.jsonc"), ["codework-acme-plugin"]));
					expect((yield* settings.load(root)).plugins).toEqual(["codework-global-plugin", "codework-acme-plugin"]);
					// A project drops an inherited plugin the same way it drops a built-in.
					yield* Effect.promise(() =>
						write(join(local, "settings.jsonc"), [{ package: "codework-global-plugin", enabled: false }]),
					);
					expect((yield* settings.load(root)).plugins).toEqual([
						"codework-global-plugin",
						{ package: "codework-global-plugin", enabled: false },
					]);
					// A layer that names no `plugins` key contributes nothing, and an empty array is
					// a layer that contributes nothing either -- neither erases what came before.
					yield* Effect.promise(() => writeFile(join(local, "settings.jsonc"), "{}"));
					expect((yield* settings.load(root)).plugins).toEqual(["codework-global-plugin"]);
				}).pipe(Effect.provide(layer)),
			);
		}));

	it("reads a --user-config-dir settings file instead of the home's, still below the project", () =>
		withSettings(async ({ root, global, local, custom }) => {
			const write = (directory: string, document: object) =>
				writeFile(join(directory, "settings.jsonc"), JSON.stringify(document));
			await write(global, { plugins: ["codework-home-plugin"], model: { thinkingLevel: "max" } });
			await write(custom, { plugins: ["codework-custom-plugin"], model: { thinkingLevel: "low" } });
			await write(local, { plugins: ["codework-project-plugin"], model: { thinkingLevel: "medium" } });
			const layer = Settings.layer({ userConfigDir: custom }).pipe(
				Layer.provide(Layer.succeed(Global.Service, Global.make({ home: global }))),
			);
			await Effect.runPromise(
				Effect.gen(function* () {
					const settings = yield* Settings.Service;
					// A hard override of the one file: the home's settings are not read at all.
					const project = yield* settings.load(root);
					expect(project.plugins).toEqual(["codework-custom-plugin", "codework-project-plugin"]);
					expect(project.declared.map((one) => one.file)).toEqual([
						join(custom, "settings.jsonc"),
						join(local, "settings.jsonc"),
					]);
					// It is the user layer, so a session's project still outranks it.
					expect(project.model.thinkingLevel).toBe("medium");
					// A session with no `hostDir` reads the user layer alone -- the override.
					const alone = yield* settings.load(undefined);
					expect(alone.plugins).toEqual(["codework-custom-plugin"]);
					expect(alone.model.thinkingLevel).toBe("low");
				}).pipe(Effect.provide(layer)),
			);
		}));
	it("carries a plugin options block through decode and merge exactly as written", () =>
		withSettings(async ({ root, global, local }) => {
			const layer = Settings.layer({}).pipe(
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
					expect((yield* settings.load(root)).plugins).toEqual([entry]);
					// And through a second layer, whose entries are appended to the first's.
					yield* Effect.promise(() =>
						writeFile(join(local, "settings.jsonc"), JSON.stringify({ plugins: [entry] })),
					);
					expect((yield* settings.load(root)).plugins).toEqual([entry, entry]);
				}).pipe(Effect.provide(layer)),
			);
		}));
	it("anchors relative plugin entries to the file that declared them", () =>
		withSettings(async ({ root, global, local }) => {
			const layer = Settings.layer().pipe(
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
					expect((yield* settings.load(root)).plugins).toEqual([
						join(global, "plugins/one.ts"),
						// A configuration entry anchors its `package`, so a relative path names the
						// same module in both spellings, and keeps the rest of the entry.
						{ package: join(root, "sibling/two.ts"), options: { deep: true } },
						// Package specs pass through untouched, and `plugin` is an ID, not a location.
						"codework-acme-plugin",
						{ plugin: "codework.tool.bash", enabled: false },
					]);
					// The project layer anchors to its own directory -- `.codework/`, not the project
					// root -- and its entries follow the user layer's rather than replacing them.
					const user = [
						join(global, "plugins/one.ts"),
						{ package: join(root, "sibling/two.ts"), options: { deep: true } },
						"codework-acme-plugin",
						{ plugin: "codework.tool.bash", enabled: false },
					];
					yield* Effect.promise(() =>
						writeFile(join(local, "settings.jsonc"), JSON.stringify({ plugins: ["./plugins/one.ts"] })),
					);
					expect((yield* settings.load(root)).plugins).toEqual([...user, join(local, "plugins/one.ts")]);
					// Nearest wins outright. A project inside a project is a different project, not
					// an extension of the outer one, so the outer file stops contributing entirely.
					const inner = join(root, "packages/app");
					yield* Effect.promise(() => mkdir(join(inner, ".codework"), { recursive: true }));
					yield* Effect.promise(() =>
						writeFile(join(inner, ".codework/settings.jsonc"), JSON.stringify({ plugins: ["./plugins/two.ts"] })),
					);
					expect((yield* settings.load(inner)).plugins).toEqual([
						...user,
						join(inner, ".codework/plugins/two.ts"),
					]);
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
			const load = (options: { readonly userConfigDir?: string }) =>
				Settings.Service.use((settings) => settings.load(root)).pipe(
					Effect.provide(
						Settings.layer(options).pipe(
							Layer.provide(Layer.succeed(Global.Service, Global.make({ home: global }))),
						),
					),
				);
			// A path that exists and cannot be read is the user's to fix, not a layer to skip.
			const error = await Effect.runPromise(load({}).pipe(Effect.flip));
			expect(error).toMatchObject({ path: join(global, "settings.jsonc"), reason: "read" });
			// Unless `--user-config-dir` replaced it: then the home's file is never opened.
			const replaced = await Effect.runPromise(load({ userConfigDir: custom }));
			expect(replaced.model).toMatchObject({ thinkingLevel: "max", options: { maxRetries: 4 } });
		}));
	it("lists both spellings per layer, and no project layer without a root", () => {
		const [user, project, extra] = paths({ home: "/home", root: "/repo" });
		// `.jsonc` is the canonical name and is tried first; `.json` still resolves.
		expect(user).toEqual(["/home/settings.jsonc", "/home/settings.json"]);
		// One layout. The project file lives in the marker directory, not beside it.
		expect(project).toEqual(["/repo/.codework/settings.jsonc", "/repo/.codework/settings.json"]);
		// Two layers, never a third.
		expect(extra).toBeUndefined();
		// `--user-config-dir` takes the user layer's place rather than adding one.
		expect(paths({ home: "/home", root: "/repo", userConfigDir: "/custom" })).toEqual([
			["/custom/settings.jsonc", "/custom/settings.json"],
			project,
		]);
		// An app-level flag: relative to `hostCwd`, never to a session's `hostDir`.
		expect(userConfigDir("relative", "/startup")).toBe("/startup/relative");
		expect(userConfigDir("~/custom", "/startup")).toBe(join(homedir(), "custom"));

		// No root means no project layer at all -- an empty group, not the user layer twice.
		expect(paths({ home: "/home" })[1]).toEqual([]);
	});
	it("keeps the file that declared each plugin entry, and the string it was written as", () =>
		withSettings(async ({ root, local, global }) => {
			await writeFile(join(global, "settings.jsonc"), JSON.stringify({ plugins: ["./plugins/user.ts"] }));
			await writeFile(
				join(local, "settings.jsonc"),
				JSON.stringify({ plugins: ["./plugins/project.ts", "@acme/explicit"] }),
			);
			const layer = Settings.layer({}).pipe(
				Layer.provide(Layer.succeed(Global.Service, Global.make({ home: global }))),
			);
			const loaded = await Effect.runPromise(
				Settings.Service.use((settings) => settings.load(root)).pipe(Effect.provide(layer)),
			);

			// Two layers can declare the same string, so attribution is genuinely gone once the
			// lists are flattened -- which is why it is carried rather than recovered.
			expect(loaded.declared.map((one) => one.file)).toEqual([
				join(global, "settings.jsonc"),
				join(local, "settings.jsonc"),
				join(local, "settings.jsonc"),
			]);
			// What the file says, and what it resolves to, are both kept: the first is what a
			// person searches for, the second is what loads.
			expect(loaded.declared.map((one) => one.written)).toEqual([
				"./plugins/user.ts",
				"./plugins/project.ts",
				"@acme/explicit",
			]);
			expect(loaded.declared.map((one) => one.entry)).toEqual([
				join(global, "plugins/user.ts"),
				join(local, "plugins/project.ts"),
				"@acme/explicit",
			]);
			// The flat list stays what the loader consumes, in the same order.
			expect(loaded.plugins).toEqual(loaded.declared.map((one) => one.entry));
		}));
	it("finds the nearest project root, and never the user config directory", () =>
		withSettings(async ({ root, global }) => {
			const inner = join(root, "packages/app");
			await mkdir(join(inner, ".codework"), { recursive: true });
			const find = (from: string, home = global) => Effect.runPromise(Settings.projectRoot(from, home));

			// An empty `.codework/` is still a project root: the marker is the directory.
			expect(await find(join(inner, "src"))).toBe(inner);
			expect(await find(join(root, "packages"))).toBe(root);

			// `<home>` is the user layer, not a project. Skipping it is what stops every user
			// plugin loading twice for a command run under `$HOME`.
			await mkdir(join(global, "sub"), { recursive: true });
			expect(await find(join(global, "sub"), global)).toBe(root);
			expect(await find("/", global)).toBeUndefined();
		}));

	it("loads the project .json fallback and prefers .jsonc when both exist", () =>
		withSettings(async ({ root, local, custom }) => {
			await writeFile(join(local, "settings.json"), JSON.stringify({ model: { thinkingLevel: "low" } }));
			const layer = Settings.layer({ userConfigDir: custom }).pipe(
				Layer.provide(Layer.succeed(Global.Service, Global.make({ home: join(root, "home") }))),
			);
			await Effect.runPromise(
				Effect.gen(function* () {
					const settings = yield* Settings.Service;
					expect((yield* settings.load(root)).model.thinkingLevel).toBe("low");
					yield* Effect.promise(() =>
						writeFile(join(local, "settings.jsonc"), JSON.stringify({ model: { thinkingLevel: "max" } })),
					);
					expect((yield* settings.load(root)).model.thinkingLevel).toBe("max");
				}).pipe(Effect.provide(layer)),
			);
		}));

	it("loads the .json fallback in every layer and merges them in order", () =>
		withSettings(async ({ root, local, global, custom }) => {
			await writeFile(
				join(global, "settings.json"),
				JSON.stringify({ model: { thinkingLevel: "low", options: { maxRetries: 2, timeoutMs: 100 } } }),
			);
			await writeFile(
				join(local, "settings.json"),
				JSON.stringify({ model: { thinkingLevel: "high", options: { timeoutMs: 200 } } }),
			);
			await writeFile(
				join(custom, "settings.json"),
				JSON.stringify({ model: { thinkingLevel: "max", options: { maxRetries: 4 } } }),
			);
			const load = (options: { readonly userConfigDir?: string }) =>
				Effect.runPromise(
					Settings.Service.use((settings) => settings.load(root)).pipe(
						Effect.provide(
							Settings.layer(options).pipe(
								Layer.provide(Layer.succeed(Global.Service, Global.make({ home: global }))),
							),
						),
					),
				);
			expect((await load({})).model).toMatchObject({
				thinkingLevel: "high",
				options: { maxRetries: 2, timeoutMs: 200 },
			});
			// The override's `.json` stands in for the home's, and the project still wins.
			expect((await load({ userConfigDir: custom })).model).toMatchObject({
				thinkingLevel: "high",
				options: { maxRetries: 4, timeoutMs: 200 },
			});
		}));
	it("fails on a malformed project file rather than falling back to the other spelling", () =>
		withSettings(async ({ root, local, custom }) => {
			await writeFile(join(local, "settings.jsonc"), '{"model":');
			await writeFile(join(local, "settings.json"), JSON.stringify({ model: { thinkingLevel: "low" } }));
			const layer = Settings.layer({ userConfigDir: custom }).pipe(
				Layer.provide(Layer.succeed(Global.Service, Global.make({ home: join(root, "home") }))),
			);
			// Only "not found" falls through to the next candidate. Skipping a file that exists
			// would silently run this session on a configuration nobody wrote.
			const error = await Effect.runPromise(
				Settings.Service.use((settings) => settings.load(root)).pipe(Effect.provide(layer), Effect.flip),
			);
			expect(error).toMatchObject({ path: join(local, "settings.jsonc"), reason: "parse" });
			expect(error.detail).toMatch(/^ValueExpected at 1:\d+$/);
		}));

	it("loads fresh files for each exchange with no shared cache or mutations", () =>
		withSettings(async ({ root, local, global, custom }) => {
			const write = (dir: string, model: object) =>
				writeFile(join(dir, "settings.jsonc"), JSON.stringify({ model }));
			const layer = Settings.layer({ userConfigDir: custom }).pipe(
				Layer.provide(Layer.succeed(Global.Service, Global.make({ home: global }))),
			);
			await Effect.runPromise(
				Effect.gen(function* () {
					const settings = yield* Settings.Service;
					expect(yield* settings.load(root)).toEqual(Settings.defaults);
					// Replaced by the override, so never part of the result.
					yield* Effect.promise(() => write(global, { options: { timeoutMs: 100, headers: { global: "yes" } } }));
					yield* Effect.promise(() => write(local, { options: { timeoutMs: 200, headers: { local: "yes" } } }));
					yield* Effect.promise(() => write(custom, { thinkingLevel: "low", options: { timeoutMs: 300 } }));
					const first = yield* settings.load(root);
					expect(first.model).toMatchObject({
						thinkingLevel: "low",
						options: { timeoutMs: 200, headers: { local: "yes" } },
					});
					expect(first.model.options?.headers).not.toHaveProperty("global");
					yield* Effect.promise(() => write(custom, { thinkingLevel: "off", options: { timeoutMs: null } }));
					const second = yield* settings.load(root);
					expect(second.model).toMatchObject({ thinkingLevel: "off", options: { timeoutMs: 200 } });
					expect(first.model.thinkingLevel).toBe("low");
					yield* Effect.promise(() => unlink(join(custom, "settings.jsonc")));
					expect((yield* settings.load(root)).model.thinkingLevel).toBe("high");
					// An edit that breaks a file reaches the next capture like any other edit. A broken
					// layer fails the load rather than handing the session to the layers around it,
					// which would run it on a configuration nobody wrote.
					yield* Effect.promise(() => writeFile(join(local, "settings.jsonc"), '{"model":'));
					yield* Effect.promise(() => write(custom, { thinkingLevel: "medium" }));
					const broken = yield* settings.load(root).pipe(Effect.flip);
					expect(broken).toMatchObject({ path: join(local, "settings.jsonc"), reason: "parse" });
					// Repaired, the next capture reads it, and an invalid value names the key it is on.
					yield* Effect.promise(() => write(local, { options: { timeoutMs: 200 } }));
					expect((yield* settings.load(root)).model).toMatchObject({
						thinkingLevel: "medium",
						options: { timeoutMs: 200 },
					});
					yield* Effect.promise(() => write(custom, { options: { timeoutMs: "wrong" } }));
					const invalid = yield* settings.load(root).pipe(Effect.flip);
					expect(invalid).toMatchObject({ reason: "decode" });
					expect(invalid.detail).toContain("model.options.timeoutMs");
				}).pipe(Effect.provide(layer)),
			);
		}));
});
