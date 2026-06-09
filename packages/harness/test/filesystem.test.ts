import { create, MemoryProvider } from "@platformatic/vfs";
import { Effect, Layer } from "effect";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { FileSystemError, Service, defaultLayer, layer, layerFromVfs } from "../src/filesystem/filesystem";
import { tmpdir } from "./fixtures/tempdir";
import { testEffect } from "./utils/effect";

describe("FileSystem", () => {
	it("reads and writes files using the configured real filesystem root", async () => {
		await using tmp = await tmpdir();

		await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* Service;
				yield* filesystem.writeFileString("/file.txt", "hello");
				expect(yield* filesystem.readFileString("/file.txt")).toBe("hello");
			}).pipe(Effect.provide(defaultLayer(tmp.path))),
		);

		expect(await fs.readFile(path.join(tmp.path, "file.txt"), "utf8")).toBe("hello");
	});

	describe("injected VFS", () => {
		const memoryVfs = create(new MemoryProvider());
		memoryVfs.mkdirSync("/directory");
		memoryVfs.writeFileSync("/file.txt", "file");

		const memoryLayer = layer.pipe(Layer.provide(layerFromVfs(memoryVfs)));
		const { effect: it } = testEffect(memoryLayer);

		it("reads and writes files without touching the real filesystem", () =>
			Effect.gen(function* () {
				const filesystem = yield* Service;

				yield* filesystem.writeFileString("/file.txt", "virtual");

				expect(yield* filesystem.readFileString("/file.txt")).toBe("virtual");
			}));

		it("identifies directories safely", () =>
			Effect.gen(function* () {
				const filesystem = yield* Service;

				expect(yield* filesystem.isDir("/directory")).toBe(true);
				expect(yield* filesystem.isDir("/file.txt")).toBe(false);
				expect(yield* filesystem.isDir("/missing")).toBe(false);
			}));

		it("maps VFS failures to FileSystemError", () =>
			Effect.gen(function* () {
				const filesystem = yield* Service;
				const error = yield* filesystem.readFileString("/missing.txt").pipe(Effect.flip);

				expect(error).toBeInstanceOf(FileSystemError);
				expect(error.method).toBe("readFileString");
				expect(error.cause).toBeDefined();
			}));
	});
});
