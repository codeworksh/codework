import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { FileSystemError, layer as filesystemLayer, Service, Vfs } from "../../src/filesystem/filesystem";
import type { Sandbox } from "../../src/sandbox/sandbox";

export interface SandboxEnv {
	readonly sandbox: Sandbox.Sandbox;
	readonly dispose?: () => Promise<void>;
}

export type MakeSandbox = () => Promise<SandboxEnv>;

// Seed the directory tree used by the `up` traversal tests through the
// sandbox's own vfs, so the fixture works for any backend.
const setupUpFixture = Effect.gen(function* () {
	const vfs = yield* Vfs;
	yield* Effect.promise(async () => {
		await vfs.promises.mkdir("/workspace/.git", { recursive: true });
		await vfs.promises.mkdir("/workspace/project/packages/app/src", { recursive: true });
		await vfs.promises.writeFile("/workspace/package.json", "{}");
		await vfs.promises.writeFile("/workspace/project/pnpm-workspace.yaml", "packages: []");
	});
});

/**
 * Behavioral spec every sandbox-provided filesystem must satisfy. Each test
 * builds a fresh sandbox via `make` and runs against the app-facing
 * FileSystem.Service, exactly as application code consumes it.
 */
export const filesystemSpec = (make: MakeSandbox) => {
	const run = async <A, E>(body: Effect.Effect<A, E, Service | Vfs>) => {
		const env = await make();
		try {
			return await Effect.runPromise(body.pipe(Effect.provide(Layer.provideMerge(filesystemLayer, env.sandbox))));
		} finally {
			await env.dispose?.();
		}
	};

	describe("filesystem behavior", () => {
		it("reads and writes file content", async () => {
			await run(
				Effect.gen(function* () {
					const fs = yield* Service;

					yield* fs.writeFileString("/file.txt", "hello");

					expect(yield* fs.readFileString("/file.txt")).toBe("hello");
				}),
			);
		});

		it("reports existence of files and directories", async () => {
			await run(
				Effect.gen(function* () {
					const fs = yield* Service;
					yield* setupUpFixture;

					expect(yield* fs.exists("/workspace/package.json")).toBe(true);
					expect(yield* fs.exists("/workspace")).toBe(true);
					expect(yield* fs.exists("/missing.txt")).toBe(false);
				}),
			);
		});

		it("identifies directories safely", async () => {
			await run(
				Effect.gen(function* () {
					const fs = yield* Service;
					yield* setupUpFixture;

					expect(yield* fs.isDir("/workspace")).toBe(true);
					expect(yield* fs.isDir("/workspace/package.json")).toBe(false);
					expect(yield* fs.isDir("/missing")).toBe(false);
				}),
			);
		});

		it("finds multiple files and directories while walking upward", async () => {
			const matches = await run(
				setupUpFixture.pipe(
					Effect.andThen(
						Effect.gen(function* () {
							const fs = yield* Service;
							return yield* fs.up({
								targets: [".git", "package.json", "pnpm-workspace.yaml"],
								start: "/workspace/project/packages/app/src",
							});
						}),
					),
				),
			);

			expect(matches).toEqual([
				"/workspace/project/pnpm-workspace.yaml",
				"/workspace/.git",
				"/workspace/package.json",
			]);
		});

		it("includes the stop directory and does not search above it", async () => {
			const matches = await run(
				setupUpFixture.pipe(
					Effect.andThen(
						Effect.gen(function* () {
							const fs = yield* Service;
							return yield* fs.up({
								targets: [".git", "package.json", "pnpm-workspace.yaml"],
								start: "/workspace/project/packages/app/src",
								stop: "/workspace/project",
							});
						}),
					),
				),
			);

			expect(matches).toEqual(["/workspace/project/pnpm-workspace.yaml"]);
		});

		it("stops at the filesystem root when stop is omitted", async () => {
			const matches = await run(
				setupUpFixture.pipe(
					Effect.andThen(
						Effect.gen(function* () {
							const fs = yield* Service;
							return yield* fs.up({
								targets: [".git", "missing.txt"],
								start: "/workspace/project/packages/app/src",
							});
						}),
					),
				),
			);

			expect(matches).toEqual(["/workspace/.git"]);
		});

		it("maps backend failures to FileSystemError", async () => {
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
	});
};
