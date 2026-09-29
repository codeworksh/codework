import { Effect, Layer } from "effect";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Global } from "../src/global.ts";
import { Settings, parse } from "../src/settings/settings.ts";

import { withSettings } from "./fixtures/settings.ts";

describe("host settings loader", () => {
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
