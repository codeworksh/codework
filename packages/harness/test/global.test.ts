import { describe, expect, it as test } from "vite-plus/test";
import fs from "node:fs/promises";
import path from "node:path";
import { Effect, Layer } from "effect";
import { Service, Path, defaultLayer, layerWith } from "../src/global";
import { testEffect } from "./utils/effect";

const it = testEffect(Layer.empty);

describe("global", () => {
	describe("Path", () => {
		test("paths are correctly derived from home directory", () => {
			expect(Path.cache).toBe(path.join(Path.home, "cache"));
			expect(Path.agent).toBe(path.join(Path.home, "agent"));
			expect(Path.data).toBe(path.join(Path.home, "data"));
			expect(Path.log).toBe(path.join(Path.home, "log"));
		});

		test("directories are created on module load", async () => {
			expect((await fs.stat(Path.cache)).isDirectory()).toBe(true);
			expect((await fs.stat(Path.agent)).isDirectory()).toBe(true);
			expect((await fs.stat(Path.data)).isDirectory()).toBe(true);
			expect((await fs.stat(Path.log)).isDirectory()).toBe(true);
		});
	});

	describe("Effect Service", () => {
		it.effect("provides the default global service", () =>
			Effect.gen(function* () {
				const service = yield* Service;
				expect(service.home).toBe(Path.home);
				expect(service.cache).toBe(Path.cache);
			}).pipe(Effect.provide(defaultLayer)),
		);

		it.effect("allows overriding paths via layerWith", () =>
			Effect.gen(function* () {
				const service = yield* Service;
				expect(service.home).toBe("/tmp/custom-home");
				expect(service.cache).toBe("/tmp/custom-cache");
				expect(service.agent).toBe(Path.agent);
			}).pipe(
				Effect.provide(
					layerWith({
						home: "/tmp/custom-home",
						cache: "/tmp/custom-cache",
					}),
				),
			),
		);
	});
});
