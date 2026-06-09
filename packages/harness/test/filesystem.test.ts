import { create, MemoryProvider } from "@platformatic/vfs";
import { Effect, Layer } from "effect";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { FileSystemError, Service, defaultLayer, layer, layerFromVfs } from "../src/filesystem/filesystem";
import { tmpdir } from "./fixtures/tempdir";
import { testEffect } from "./utils/effect";

const setupUpFixture = async (root: string) => {
	await fs.mkdir(path.join(root, "workspace", ".git"), { recursive: true });
	await fs.mkdir(path.join(root, "workspace", "project", "packages", "app", "src"), { recursive: true });
	await fs.writeFile(path.join(root, "workspace", "package.json"), "{}");
	await fs.writeFile(path.join(root, "workspace", "project", "pnpm-workspace.yaml"), "packages: []");
};

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

	describe("up with real filesystem", () => {
		it("finds multiple files and directories while walking upward", async () => {
			await using tmp = await tmpdir();
			await setupUpFixture(tmp.path);

			const matches = await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;
					return yield* filesystem.up({
						targets: [".git", "package.json", "pnpm-workspace.yaml"],
						start: "/workspace/project/packages/app/src",
					});
				}).pipe(Effect.provide(defaultLayer(tmp.path))),
			);

			expect(matches).toEqual([
				"/workspace/project/pnpm-workspace.yaml",
				"/workspace/.git",
				"/workspace/package.json",
			]);
		});

		it("includes the stop directory and does not search above it", async () => {
			await using tmp = await tmpdir();
			await setupUpFixture(tmp.path);

			const matches = await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;
					return yield* filesystem.up({
						targets: [".git", "package.json", "pnpm-workspace.yaml"],
						start: "/workspace/project/packages/app/src",
						stop: "/workspace/project",
					});
				}).pipe(Effect.provide(defaultLayer(tmp.path))),
			);

			expect(matches).toEqual(["/workspace/project/pnpm-workspace.yaml"]);
		});

		it("stops at the virtual filesystem root when stop is omitted", async () => {
			await using tmp = await tmpdir();
			await setupUpFixture(tmp.path);

			const matches = await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;
					return yield* filesystem.up({
						targets: [".git", "missing.txt"],
						start: "/workspace/project/packages/app/src",
					});
				}).pipe(Effect.provide(defaultLayer(tmp.path))),
			);

			expect(matches).toEqual(["/workspace/.git"]);
		});
	});

	describe("injected VFS", () => {
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
});
