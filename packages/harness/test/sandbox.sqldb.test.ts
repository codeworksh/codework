import { Cause, Effect, Exit } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import { filesystemSpec, withService } from "./fixtures/sandbox.spec.ts";
import { tmpdir } from "./fixtures/tempdir.ts";

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

	describe("with seed", () => {
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
	});
});
