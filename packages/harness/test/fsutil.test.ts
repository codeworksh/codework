import { Effect } from "effect";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { FSUtil, FileSystemError } from "../src/fsutil/fsutil.ts";
import { tmpdir } from "./fixtures/tempdir.ts";

// Host-side helpers over @effect/platform, for the machine the harness runs on
// — distinct from the sandbox runtime filesystem, which everything touching a
// workspace goes through instead.
const run = <A, E>(body: Effect.Effect<A, E, FSUtil.Service>) =>
	Effect.runPromise(body.pipe(Effect.provide(FSUtil.defaultLayer)));

describe("FSUtil", () => {
	describe("writeFileString / readFileString", () => {
		it("writes, creating missing parents, and reads back", async () => {
			await using tmp = await tmpdir();
			await run(
				Effect.gen(function* () {
					const filesystem = yield* FSUtil.Service;
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
					const filesystem = yield* FSUtil.Service;
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
					const filesystem = yield* FSUtil.Service;
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
					const filesystem = yield* FSUtil.Service;

					expect(yield* filesystem.exists(path.join(tmp.path, "file.txt"))).toBe(true);
					expect(yield* filesystem.exists(path.join(tmp.path, "missing"))).toBe(false);

					expect(yield* filesystem.isDir(path.join(tmp.path, "dir"))).toBe(true);
					expect(yield* filesystem.isDir(path.join(tmp.path, "file.txt"))).toBe(false);
					expect(yield* filesystem.isDir(path.join(tmp.path, "missing"))).toBe(false);
				}),
			);
		});
	});
});
