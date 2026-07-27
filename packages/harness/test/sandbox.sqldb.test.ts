import { Cause, Effect, Exit } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Sandbox } from "../src/sandbox/sandbox";
import { filesystemSpec, withService } from "./fixtures/sandbox.spec";
import { tmpdir } from "./fixtures/tempdir";

describe("Sandbox.EnvSQLiteFS", () => {
	describe("with sqlite in-memory filesystem spec", () => {
		filesystemSpec(async () => ({
			sandbox: Sandbox.EnvSqldb.layer(),
		}));
	});

	describe("with sqlite file-backed filesystem spec", () => {
		filesystemSpec(async () => {
			const tmp = await tmpdir();
			return {
				sandbox: Sandbox.EnvSqldb.layer({ location: path.join(tmp.path, "fs.db") }),
				dispose: () => tmp[Symbol.asyncDispose](),
			};
		});

		// the database file outlives the sandbox: a fresh layer build against
		// the same file sees everything written by the previous lifetime
		it("should persist files across sandbox lifetimes", async () => {
			await using tmp = await tmpdir();
			const database = path.join(tmp.path, "fs.db");

			await withService(
				async () => ({ sandbox: Sandbox.EnvSqldb.layer({ location: database }) }),
				(filesystem) => filesystem.writeFile("/file.txt", "persisted"),
			);

			const content = await withService(
				async () => ({ sandbox: Sandbox.EnvSqldb.layer({ location: database }) }),
				(filesystem) => filesystem.readFile("/file.txt"),
			);

			expect(content).toBe("persisted");
		});
	});

	// each in-memory sandbox owns its own database: nothing leaks between
	// independent layer builds
	it("should isolate in-memory sandboxes with no leakage", async () => {
		await withService(
			async () => ({ sandbox: Sandbox.EnvSqldb.layer() }),
			(filesystem) => filesystem.writeFile("/file.txt", "first"),
		);

		const exists = await withService(
			async () => ({ sandbox: Sandbox.EnvSqldb.layer() }),
			(filesystem) => filesystem.exists("/file.txt"),
		);

		expect(exists).toBe(false);
	});

	it("should refuse host process execution when `hostProcess` is disabled", async () => {
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
				return yield* Effect.scoped(spawner.spawn(ChildProcess.make("git", ["status"])));
			}).pipe(Effect.provide(Sandbox.EnvSqldb.layer())),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			expect(Cause.pretty(exit.cause)).toContain("process execution is not supported by this sandbox");
		}
	});

	// hostProcess opts out of the refusal: the filesystem stays virtual but
	// child processes run on the host OS
	it("should spawn host processes when `hostProcess` is enabled", async () => {
		const exitCode = await Effect.runPromise(
			Effect.gen(function* () {
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
				return yield* spawner.exitCode(ChildProcess.make("echo", ["hello"]));
			}).pipe(Effect.provide(Sandbox.EnvSqldb.layer({ options: { hostProcess: true } }))),
		);

		expect(exitCode).toBe(0);
	});

	describe("with seed", () => {
		it("should write inline seed files before the sandbox is used", async () => {
			await withService(
				async () => ({
					sandbox: Sandbox.EnvSqldb.layer({
						options: {
							seed: {
								"/repo/package.json": "{}",
								"/repo/src/index.ts": "export const value = 1;\n",
							},
						},
					}),
				}),
				async (filesystem) => {
					expect(await filesystem.readFile("/repo/package.json")).toBe("{}");
					expect(await filesystem.readFile("/repo/src/index.ts")).toBe("export const value = 1;\n");
				},
			);
		});

		it("should resolve relative seed paths against cwd", async () => {
			await withService(
				async () => ({
					sandbox: Sandbox.EnvSqldb.layer({ options: { cwd: "/repo", seed: { "package.json": "{}" } } }),
					cwd: "/repo",
				}),
				async (filesystem) => {
					expect(await filesystem.readFile("package.json")).toBe("{}");
					expect(await filesystem.readFile("/repo/package.json")).toBe("{}");
					expect(await filesystem.exists("/package.json")).toBe(false);
				},
			);
		});

		it("should freeze seeded files when readOnly is enabled", async () => {
			await withService(
				async () => ({
					sandbox: Sandbox.EnvSqldb.layer({ options: { seed: { "/repo/package.json": "{}" }, readOnly: true } }),
				}),
				async (filesystem) => {
					expect(await filesystem.readFile("/repo/package.json")).toBe("{}");
					await expect(filesystem.writeFile("/repo/other.txt", "nope")).rejects.toBeDefined();
				},
			);
		});
	});

	describe("with cwd", () => {
		it("should resolve relative file operations against cwd", async () => {
			await withService(
				async () => ({ sandbox: Sandbox.EnvSqldb.layer({ options: { cwd: "/repo" } }), cwd: "/repo" }),
				async (filesystem) => {
					await filesystem.writeFile("src/index.ts", "export const value = 1;\n");

					expect(await filesystem.readFile("src/index.ts")).toBe("export const value = 1;\n");
					expect(await filesystem.readFile("/repo/src/index.ts")).toBe("export const value = 1;\n");
					expect(await filesystem.exists("src/index.ts")).toBe(true);
					expect(await filesystem.exists("/src/index.ts")).toBe(false);
					expect((await filesystem.stat("src")).isDirectory).toBe(true);
				},
			);
		});
	});

	describe("with read only", () => {
		it("should reject writes when created with readOnly", async () => {
			await withService(
				async () => ({
					sandbox: Sandbox.EnvSqldb.layer({ options: { cwd: "/repo", readOnly: true } }),
					cwd: "/repo",
				}),
				async (filesystem) => {
					await expect(filesystem.writeFile("/file.txt", "nope")).rejects.toBeDefined();
				},
			);
		});

		it("should still serve reads when read-only", async () => {
			await withService(
				async () => ({
					sandbox: Sandbox.EnvSqldb.layer({ options: { cwd: "/repo", readOnly: true } }),
					cwd: "/repo",
				}),
				async (filesystem) => {
					expect((await filesystem.stat("/")).isDirectory).toBe(true);
					expect(await filesystem.exists("/")).toBe(true);
					expect(await filesystem.exists("/missing.txt")).toBe(false);
				},
			);
		});
	});
});
