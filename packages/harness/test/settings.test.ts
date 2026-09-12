import { Effect, Layer, Logger } from "effect";
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
			const failure = await Effect.runPromise(parse("settings.json", JSON.stringify({ plugins })).pipe(Effect.flip));
			expect(failure).toMatchObject({ reason: "decode" });
			expect(failure.detail).toContain("plugins");
		},
	);

	it("resolves plugin arrays by layer, replacing rather than concatenating", () =>
		withSettings(async ({ root, global, local, custom }) => {
			const write = (path: string, plugins: ReadonlyArray<string>) => writeFile(path, JSON.stringify({ plugins }));
			const layer = Settings.layer({ cwd: root, userConfigDir: custom }).pipe(
				Layer.provide(Layer.succeed(Global.Service, Global.make({ home: global }))),
			);
			await Effect.runPromise(
				Effect.gen(function* () {
					const settings = yield* Settings.Service;
					expect((yield* settings.load).plugins).toEqual([]);
					yield* Effect.promise(() => write(join(global, "settings.json"), ["codework-global-plugin"]));
					expect((yield* settings.load).plugins).toEqual(["codework-global-plugin"]);
					yield* Effect.promise(() => write(join(local, "settings.json"), ["codework-local-plugin"]));
					expect((yield* settings.load).plugins).toEqual(["codework-local-plugin"]);
					yield* Effect.promise(() =>
						write(join(root, "codework.json"), ["codework-acme-plugin", "codework-other-plugin"]),
					);
					expect((yield* settings.load).plugins).toEqual(["codework-acme-plugin", "codework-other-plugin"]);
					yield* Effect.promise(() => writeFile(join(root, "codework.json"), "{}"));
					expect((yield* settings.load).plugins).toEqual(["codework-global-plugin"]);
					yield* Effect.promise(() => write(join(root, "codework.json"), []));
					expect((yield* settings.load).plugins).toEqual([]);
					yield* Effect.promise(() => write(join(custom, "settings.json"), ["codework-custom-plugin"]));
					expect((yield* settings.load).plugins).toEqual(["codework-custom-plugin"]);
				}).pipe(Effect.provide(layer)),
			);
		}));

	it("anchors relative plugin entries to the file that declared them", () =>
		withSettings(async ({ root, global, local }) => {
			const layer = Settings.layer({ cwd: root }).pipe(
				Layer.provide(Layer.succeed(Global.Service, Global.make({ home: global }))),
			);
			const entries = ["./plugins/one.ts", "../sibling/two.ts", "codework-acme-plugin", "!codework.tool.bash"];
			await Effect.runPromise(
				Effect.gen(function* () {
					const settings = yield* Settings.Service;
					yield* Effect.promise(() =>
						writeFile(join(global, "settings.json"), JSON.stringify({ plugins: entries })),
					);
					expect((yield* settings.load).plugins).toEqual([
						join(global, "plugins/one.ts"),
						join(root, "sibling/two.ts"),
						// IDs, disables and package specs pass through untouched.
						"codework-acme-plugin",
						"!codework.tool.bash",
					]);
					// The project layer anchors to its own directory, which differs between the two layouts.
					yield* Effect.promise(() =>
						writeFile(join(local, "settings.json"), JSON.stringify({ plugins: ["./plugins/one.ts"] })),
					);
					expect((yield* settings.load).plugins).toEqual([join(local, "plugins/one.ts")]);
					yield* Effect.promise(() =>
						writeFile(join(root, "codework.json"), JSON.stringify({ plugins: ["./plugins/one.ts"] })),
					);
					expect((yield* settings.load).plugins).toEqual([join(root, "plugins/one.ts")]);
				}).pipe(Effect.provide(layer)),
			);
		}));

	it("reports syntax locations and decode paths without exposing values", async () => {
		const malformed = '{\n"model": {"options": {"timeoutMs": 2,, "secret": "do-not-print"}}}';
		const syntax = await Effect.runPromise(parse("broken.json", malformed).pipe(Effect.flip));
		expect(syntax).toMatchObject({ path: "broken.json", reason: "parse" });
		expect(syntax.detail).toMatch(/Invalid JSON at 2:\d+/);
		expect(syntax.detail).not.toContain("do-not-print");
		const invalid = await Effect.runPromise(
			parse("invalid.json", '{"model":{"options":{"timeoutMs":"do-not-print"}}}').pipe(Effect.flip),
		);
		expect(invalid.detail).toContain("model.options.timeoutMs");
		expect(invalid.detail).not.toContain("do-not-print");
	});

	it("skips an unreadable layer and never searches the startup directory's parents", () =>
		withSettings(async ({ root, local, global, custom }) => {
			await mkdir(join(global, "settings.json"));
			await writeFile(join(local, "settings.json"), JSON.stringify({ model: { thinkingLevel: "max" } }));
			await writeFile(join(custom, "settings.json"), JSON.stringify({ model: { options: { maxRetries: 4 } } }));
			const layer = Settings.layer({ cwd: join(root, "subdirectory"), userConfigDir: custom }).pipe(
				Layer.provide(Layer.succeed(Global.Service, Global.make({ home: join(root, "home") }))),
			);
			const result = await Effect.runPromise(
				Settings.Service.use((settings) => settings.load).pipe(Effect.provide(layer)),
			);
			expect(result.model.thinkingLevel).toBe(Settings.defaults.model.thinkingLevel);
			expect(result.model.options?.maxRetries).toBe(4);
		}));

	it("uses global, startup-local, custom paths and expands home", () => {
		expect(paths("/home", "/startup", "relative")).toEqual([
			["/home/settings.json"],
			["/startup/codework.json", "/startup/.codework/settings.json"],
			["/startup/relative/settings.json"],
		]);
		expect(paths("/home", "/startup", "~/custom").at(-1)).toEqual([join(homedir(), "custom/settings.json")]);
	});

	it("loads codework.json as the project layer", () =>
		withSettings(async ({ root, custom }) => {
			await writeFile(join(root, "codework.json"), JSON.stringify({ model: { thinkingLevel: "low" } }));
			const layer = Settings.layer({ cwd: root, userConfigDir: custom }).pipe(
				Layer.provide(Layer.succeed(Global.Service, Global.make({ home: join(root, "home") }))),
			);
			const result = await Effect.runPromise(
				Settings.Service.use((settings) => settings.load).pipe(Effect.provide(layer)),
			);
			expect(result.model.thinkingLevel).toBe("low");
			expect(result.model.options?.maxRetries).toBe(3);
		}));

	it("prefers codework.json over .codework/settings.json when both exist", () =>
		withSettings(async ({ root, local, custom }) => {
			await writeFile(
				join(root, "codework.json"),
				JSON.stringify({ model: { thinkingLevel: "max", options: { maxRetries: 2 } } }),
			);
			await writeFile(
				join(local, "settings.json"),
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

	it("merges global, codework.json, and custom settings without using global codework.json", () =>
		withSettings(async ({ root, global, custom }) => {
			await writeFile(
				join(global, "codework.json"),
				JSON.stringify({ model: { options: { headers: { excluded: "yes" } } } }),
			);
			await writeFile(
				join(global, "settings.json"),
				JSON.stringify({ model: { thinkingLevel: "low", options: { maxRetries: 2, timeoutMs: 100 } } }),
			);
			await writeFile(
				join(root, "codework.json"),
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

	it("falls back to .codework/settings.json only when codework.json is missing", () =>
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
						writeFile(join(root, "codework.json"), JSON.stringify({ model: { thinkingLevel: "max" } })),
					);
					expect((yield* settings.load).model.thinkingLevel).toBe("max");
					yield* Effect.promise(() => unlink(join(root, "codework.json")));
					expect((yield* settings.load).model.thinkingLevel).toBe("low");
				}).pipe(Effect.provide(layer)),
			);
		}));

	it("warns on a malformed codework.json without falling back to the directory file", () =>
		withSettings(async ({ root, local, custom }) => {
			await writeFile(join(root, "codework.json"), '{"model":');
			await writeFile(join(local, "settings.json"), JSON.stringify({ model: { thinkingLevel: "low" } }));
			const layer = Settings.layer({ cwd: root, userConfigDir: custom }).pipe(
				Layer.provide(Layer.succeed(Global.Service, Global.make({ home: join(root, "home") }))),
			);
			const logs: Array<{ level: string; message: unknown }> = [];
			const logger = Logger.make((entry) => {
				logs.push({ level: entry.logLevel, message: entry.message });
			});
			const result = await Effect.runPromise(
				Settings.Service.use((settings) => settings.load).pipe(
					Effect.provide(layer),
					Effect.provide(Logger.layer([logger])),
				),
			);
			expect(result.model.thinkingLevel).toBe(Settings.defaults.model.thinkingLevel);
			expect(logs).toEqual([
				{
					level: "Warn",
					message: [expect.stringContaining(`Settings: ${join(root, "codework.json")}: parse: Invalid JSON`)],
				},
			]);
		}));

	it("loads fresh files for each exchange with no shared cache or mutations", () =>
		withSettings(async ({ root, local, global, custom }) => {
			const write = (dir: string, model: object) => writeFile(join(dir, "settings.json"), JSON.stringify({ model }));
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
					yield* Effect.promise(() => unlink(join(custom, "settings.json")));
					expect((yield* settings.load).model.thinkingLevel).toBe("high");
					// A malformed middle layer must not prevent a valid higher layer from applying.
					yield* Effect.promise(() => writeFile(join(local, "settings.json"), '{"model":'));
					yield* Effect.promise(() => write(custom, { thinkingLevel: "medium" }));
					expect((yield* settings.load).model).toMatchObject({
						thinkingLevel: "medium",
						options: { timeoutMs: 100 },
					});
					yield* Effect.promise(() => write(custom, { options: { timeoutMs: "wrong" } }));
					expect((yield* settings.load).model.options?.timeoutMs).toBe(100);
				}).pipe(Effect.provide(layer)),
			);
		}));
});
