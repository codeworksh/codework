import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { FileSystemError, layer as filesystemLayer, Service, Vfs } from "../../src/filesystem/filesystem";
import type { Sandbox } from "../../src/sandbox/sandbox";

export interface SandboxEnv {
	readonly sandbox: Sandbox.Sandbox;
	readonly dispose?: () => Promise<void>;
}

export type MakeSandbox = () => Promise<SandboxEnv>;

// Seed a directory tree through the sandbox's own vfs, so the fixture works
// for any backend:
//
//   /workspace/.git/
//   /workspace/package.json
//   /workspace/project/package.json
//   /workspace/project/pnpm-workspace.yaml
//   /workspace/project/packages/app/src/
const seed = Effect.gen(function* () {
	const vfs = yield* Vfs;
	yield* Effect.promise(async () => {
		await vfs.promises.mkdir("/workspace/.git", { recursive: true });
		await vfs.promises.mkdir("/workspace/project/packages/app/src", { recursive: true });
		await vfs.promises.writeFile("/workspace/package.json", "{}");
		await vfs.promises.writeFile("/workspace/project/package.json", "{}");
		await vfs.promises.writeFile("/workspace/project/pnpm-workspace.yaml", "packages: []");
	});
});

/**
 * Behavioral spec every sandbox-provided filesystem must satisfy, covering
 * the full FileSystem.Service surface — success and failure paths of every
 * method. Each test builds a fresh sandbox via `make` and consumes the
 * service exactly as application code does.
 */
export const filesystemSpec = (make: MakeSandbox) => {
	const run = async <A, E>(body: Effect.Effect<A, E, Service | Vfs>) => {
		const env = await make();
		try {
			return await Effect.runPromise(
				seed.pipe(Effect.andThen(body), Effect.provide(Layer.provideMerge(filesystemLayer, env.sandbox))),
			);
		} finally {
			await env.dispose?.();
		}
	};

	describe("readFileString", () => {
		it("reads existing file content", async () => {
			await run(
				Effect.gen(function* () {
					const fs = yield* Service;

					expect(yield* fs.readFileString("/workspace/package.json")).toBe("{}");
					expect(yield* fs.readFileString("/workspace/package.json", "utf8")).toBe("{}");
				}),
			);
		});

		it("round-trips multi-line and non-ascii content", async () => {
			await run(
				Effect.gen(function* () {
					const fs = yield* Service;
					const content = "héllo\nwörld\n🚀";

					yield* fs.writeFileString("/notes.txt", content);

					expect(yield* fs.readFileString("/notes.txt")).toBe(content);
				}),
			);
		});

		it("fails with FileSystemError for a missing file", async () => {
			await run(
				Effect.gen(function* () {
					const fs = yield* Service;
					const error = yield* fs.readFileString("/missing.txt").pipe(Effect.flip);

					expect(error).toBeInstanceOf(FileSystemError);
					expect(error.method).toBe("readFileString");
					expect(error.cause).toBeDefined();
				}),
			);
		});

		it("fails with FileSystemError when reading a directory", async () => {
			await run(
				Effect.gen(function* () {
					const fs = yield* Service;
					const error = yield* fs.readFileString("/workspace").pipe(Effect.flip);

					expect(error).toBeInstanceOf(FileSystemError);
					expect(error.method).toBe("readFileString");
				}),
			);
		});
	});

	describe("writeFileString", () => {
		it("creates a new file", async () => {
			await run(
				Effect.gen(function* () {
					const fs = yield* Service;

					yield* fs.writeFileString("/file.txt", "hello");

					expect(yield* fs.readFileString("/file.txt")).toBe("hello");
					expect(yield* fs.exists("/file.txt")).toBe(true);
				}),
			);
		});

		it("overwrites existing content", async () => {
			await run(
				Effect.gen(function* () {
					const fs = yield* Service;

					yield* fs.writeFileString("/file.txt", "first");
					yield* fs.writeFileString("/file.txt", "second");

					expect(yield* fs.readFileString("/file.txt")).toBe("second");
				}),
			);
		});

		it("creates missing parent directories", async () => {
			await run(
				Effect.gen(function* () {
					const fs = yield* Service;

					yield* fs.writeFileString("/deeply/nested/dir/file.txt", "data");

					expect(yield* fs.readFileString("/deeply/nested/dir/file.txt")).toBe("data");
					expect(yield* fs.isDir("/deeply/nested/dir")).toBe(true);
				}),
			);
		});

		it("fails with FileSystemError when writing over a directory", async () => {
			await run(
				Effect.gen(function* () {
					const fs = yield* Service;
					const error = yield* fs.writeFileString("/workspace", "data").pipe(Effect.flip);

					expect(error).toBeInstanceOf(FileSystemError);
					expect(error.method).toBe("writeFileString");
					expect(error.cause).toBeDefined();
				}),
			);
		});
	});

	describe("exists", () => {
		it("reports files, directories, and the root", async () => {
			await run(
				Effect.gen(function* () {
					const fs = yield* Service;

					expect(yield* fs.exists("/")).toBe(true);
					expect(yield* fs.exists("/workspace")).toBe(true);
					expect(yield* fs.exists("/workspace/package.json")).toBe(true);
				}),
			);
		});

		it("returns false instead of failing for missing paths", async () => {
			await run(
				Effect.gen(function* () {
					const fs = yield* Service;

					expect(yield* fs.exists("/missing.txt")).toBe(false);
					expect(yield* fs.exists("/missing/deeply/nested")).toBe(false);
					expect(yield* fs.exists("/workspace/package.json/below-a-file")).toBe(false);
				}),
			);
		});
	});

	describe("isDir", () => {
		it("identifies directories including the root", async () => {
			await run(
				Effect.gen(function* () {
					const fs = yield* Service;

					expect(yield* fs.isDir("/")).toBe(true);
					expect(yield* fs.isDir("/workspace")).toBe(true);
					expect(yield* fs.isDir("/workspace/.git")).toBe(true);
				}),
			);
		});

		it("returns false for files", async () => {
			await run(
				Effect.gen(function* () {
					const fs = yield* Service;

					expect(yield* fs.isDir("/workspace/package.json")).toBe(false);
				}),
			);
		});

		it("returns false instead of failing for missing paths", async () => {
			await run(
				Effect.gen(function* () {
					const fs = yield* Service;

					expect(yield* fs.isDir("/missing")).toBe(false);
					expect(yield* fs.isDir("/missing/deeply/nested")).toBe(false);
				}),
			);
		});
	});

	describe("up", () => {
		it("finds multiple files and directories while walking upward", async () => {
			const matches = await run(
				Effect.gen(function* () {
					const fs = yield* Service;
					return yield* fs.up({
						targets: [".git", "package.json", "pnpm-workspace.yaml"],
						start: "/workspace/project/packages/app/src",
					});
				}),
			);

			expect(matches).toEqual([
				"/workspace/project/package.json",
				"/workspace/project/pnpm-workspace.yaml",
				"/workspace/.git",
				"/workspace/package.json",
			]);
		});

		it("collects the same target at multiple levels", async () => {
			const matches = await run(
				Effect.gen(function* () {
					const fs = yield* Service;
					return yield* fs.up({
						targets: ["package.json"],
						start: "/workspace/project/packages/app/src",
						stop: "/workspace",
					});
				}),
			);

			expect(matches).toEqual(["/workspace/project/package.json", "/workspace/package.json"]);
		});

		it("includes the stop directory and does not search above it", async () => {
			const matches = await run(
				Effect.gen(function* () {
					const fs = yield* Service;
					return yield* fs.up({
						targets: [".git", "pnpm-workspace.yaml"],
						start: "/workspace/project/packages/app/src",
						stop: "/workspace/project",
					});
				}),
			);

			expect(matches).toEqual(["/workspace/project/pnpm-workspace.yaml"]);
		});

		it("stops at the filesystem root when stop is omitted", async () => {
			const matches = await run(
				Effect.gen(function* () {
					const fs = yield* Service;
					return yield* fs.up({
						targets: [".git", "missing.txt"],
						start: "/workspace/project/packages/app/src",
					});
				}),
			);

			expect(matches).toEqual(["/workspace/.git"]);
		});

		it("returns an empty list when nothing matches", async () => {
			const matches = await run(
				Effect.gen(function* () {
					const fs = yield* Service;
					return yield* fs.up({
						targets: ["missing.txt"],
						start: "/workspace/project/packages/app/src",
					});
				}),
			);

			expect(matches).toEqual([]);
		});
	});
};
