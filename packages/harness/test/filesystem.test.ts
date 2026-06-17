import { Effect } from "effect";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { FileSystem, FileSystemError } from "../src/filesystem/filesystem";
import { tmpdir } from "./fixtures/tempdir";

// The application-level FileSystem service operates on the real host OS through
// @effect/platform — distinct from the sandbox runtime filesystem. project.ts,
// copy.ts, and git.ts consume it.
const run = <A, E>(body: Effect.Effect<A, E, FileSystem.Service>) =>
	Effect.runPromise(body.pipe(Effect.provide(FileSystem.defaultLayer)));

describe("FileSystem (application)", () => {
	describe("writeFileString / readFileString", () => {
		it("writes, creating missing parents, and reads back", async () => {
			await using tmp = await tmpdir();
			await run(
				Effect.gen(function* () {
					const filesystem = yield* FileSystem.Service;
					const file = path.join(tmp.path, "nested", "dir", "file.txt");

					yield* filesystem.writeFileString(file, "hello");
					expect(yield* filesystem.readFileString(file)).toBe("hello");
				}),
			);
		});

		it("fails with FileSystemError reading a missing file", async () => {
			await using tmp = await tmpdir();
			const error = await run(
				Effect.gen(function* () {
					const filesystem = yield* FileSystem.Service;
					return yield* filesystem.readFileString(path.join(tmp.path, "missing.txt")).pipe(Effect.flip);
				}),
			);

			expect(error).toBeInstanceOf(FileSystemError);
			expect(error.method).toBe("readFileString");
		});

		it("fails with FileSystemError writing over a directory", async () => {
			await using tmp = await tmpdir();
			await fs.mkdir(path.join(tmp.path, "dir"));
			const error = await run(
				Effect.gen(function* () {
					const filesystem = yield* FileSystem.Service;
					return yield* filesystem.writeFileString(path.join(tmp.path, "dir"), "data").pipe(Effect.flip);
				}),
			);

			expect(error).toBeInstanceOf(FileSystemError);
			expect(error.method).toBe("writeFileString");
		});
	});

	describe("exists / isDir", () => {
		it("reports files, directories, and missing paths", async () => {
			await using tmp = await tmpdir();
			await fs.writeFile(path.join(tmp.path, "file.txt"), "data");
			await fs.mkdir(path.join(tmp.path, "dir"));

			await run(
				Effect.gen(function* () {
					const filesystem = yield* FileSystem.Service;

					expect(yield* filesystem.exists(path.join(tmp.path, "file.txt"))).toBe(true);
					expect(yield* filesystem.exists(path.join(tmp.path, "missing"))).toBe(false);

					expect(yield* filesystem.isDir(path.join(tmp.path, "dir"))).toBe(true);
					expect(yield* filesystem.isDir(path.join(tmp.path, "file.txt"))).toBe(false);
					expect(yield* filesystem.isDir(path.join(tmp.path, "missing"))).toBe(false);
				}),
			);
		});
	});

	describe("up", () => {
		it("collects targets while walking toward the root", async () => {
			await using tmp = await tmpdir();
			const workspace = path.join(tmp.path, "workspace");
			const start = path.join(workspace, "project", "packages", "app");
			await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
			await fs.mkdir(start, { recursive: true });
			await fs.writeFile(path.join(workspace, "package.json"), "{}");
			await fs.writeFile(path.join(workspace, "project", "package.json"), "{}");

			const matches = await run(
				Effect.gen(function* () {
					const filesystem = yield* FileSystem.Service;
					return yield* filesystem.up({ targets: [".git", "package.json"], start, stop: workspace });
				}),
			);

			expect(matches).toEqual([
				path.join(workspace, "project", "package.json"),
				path.join(workspace, ".git"),
				path.join(workspace, "package.json"),
			]);
		});
	});
});
