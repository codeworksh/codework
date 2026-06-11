import { create, MemoryProvider } from "@platformatic/vfs";
import { Effect, Layer } from "effect";
import { describe, expect } from "vite-plus/test";
import { FileSystemError, layer, layerFromVfs, Service } from "../src/filesystem/filesystem";
import { testEffect } from "./utils/effect";

// Service-level unit tests against an injected memory vfs. Sandbox-backed
// behavior (real filesystem, sqlite) is covered by the shared spec in
// sandbox.default.test.ts and sandbox.sqldb.test.ts.
describe("FileSystem", () => {
	const memoryVfs = create(new MemoryProvider());
	memoryVfs.mkdirSync("/directory");
	memoryVfs.mkdirSync("/workspace/project/src", { recursive: true });
	memoryVfs.writeFileSync("/file.txt", "file");
	memoryVfs.writeFileSync("/workspace/package.json", "{}");
	memoryVfs.writeFileSync("/workspace/project/package.json", "{}");

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

	it("finds targets while walking up the VFS", () =>
		Effect.gen(function* () {
			const filesystem = yield* Service;

			const matches = yield* filesystem.up({
				targets: ["package.json"],
				start: "/workspace/project/src",
				stop: "/workspace",
			});

			expect(matches).toEqual(["/workspace/project/package.json", "/workspace/package.json"]);
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
