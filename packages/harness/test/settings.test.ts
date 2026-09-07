import { Effect, Layer } from "effect";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Global } from "../src/global.ts";
import { Settings, parse, paths } from "../src/settings/settings.ts";

import { withSettings } from "./fixtures/settings.ts";

describe("host settings loader", () => {
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
		expect(paths("/home/config", "/startup", "relative")).toEqual([
			"/home/config/settings.json",
			"/startup/.codework/config/settings.json",
			"/startup/relative/settings.json",
		]);
		expect(paths("/home/config", "/startup", "~/custom").at(-1)).toBe(join(homedir(), "custom/settings.json"));
	});

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
