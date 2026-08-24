import { describe, expect, it as test } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigProvider, Effect, Layer } from "effect";
import { Service, defaultLayer, layerWith, make } from "../src/global.ts";
import { testEffect } from "./utils/effect.ts";

const it = testEffect(Layer.empty);

describe("global", () => {
	describe("paths", () => {
		test("paths are correctly derived from home directory", () => {
			const home = path.resolve("custom-home");
			const paths = make({ home });
			expect(paths.cache).toBe(path.join(home, "cache"));
			expect(paths.agent).toBe(path.join(home, "agent"));
			expect(paths.data).toBe(path.join(home, "data"));
			expect(paths.log).toBe(path.join(home, "log"));
		});

		it.effect("creates the selected tree when its layer is constructed", () =>
			Effect.acquireUseRelease(
				Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "codework-global-"))),
				(home) =>
					Effect.gen(function* () {
						const service = yield* Service;
						expect(service.home).toBe(home);
						for (const directory of [service.cache, service.agent, service.data, service.log]) {
							expect((yield* Effect.promise(() => fs.stat(directory))).isDirectory()).toBe(true);
						}
					}).pipe(Effect.provide(layerWith({ home }))),
				(home) => Effect.promise(() => fs.rm(home, { recursive: true, force: true })),
			),
		);
	});

	describe("Effect Service", () => {
		it.effect("reads the default home through ConfigProvider", () =>
			Effect.acquireUseRelease(
				Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "codework-global-config-"))),
				(home) =>
					Effect.gen(function* () {
						const service = yield* Service;
						expect(service.home).toBe(home);
						expect(service.cache).toBe(path.join(home, "cache"));
					}).pipe(
						Effect.provide(defaultLayer),
						Effect.provideService(
							ConfigProvider.ConfigProvider,
							ConfigProvider.fromUnknown({ CODEWORK_HOME_DIR: home }),
						),
					),
				(home) => Effect.promise(() => fs.rm(home, { recursive: true, force: true })),
			),
		);

		it.effect("allows explicit paths to override ConfigProvider", () =>
			Effect.acquireUseRelease(
				Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "codework-global-override-"))),
				(root) =>
					Effect.gen(function* () {
						const home = path.join(root, "explicit");
						const cache = path.join(home, "custom-cache");
						const service = yield* Service;
						expect(service.home).toBe(home);
						expect(service.cache).toBe(cache);
						expect(service.agent).toBe(path.join(home, "agent"));
					}).pipe(
						Effect.provide(
							layerWith({
								home: path.join(root, "explicit"),
								cache: path.join(root, "explicit", "custom-cache"),
							}),
						),
						Effect.provideService(
							ConfigProvider.ConfigProvider,
							ConfigProvider.fromUnknown({ CODEWORK_HOME_DIR: path.join(root, "configured") }),
						),
					),
				(root) => Effect.promise(() => fs.rm(root, { recursive: true, force: true })),
			),
		);
	});
});
