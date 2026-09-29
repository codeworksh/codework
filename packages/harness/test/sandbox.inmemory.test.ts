import { Cause, Effect, Exit } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vite-plus/test";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import { filesystemSpec, withService } from "./fixtures/sandbox.spec.ts";

describe("Sandbox.EnvInMemoryFS", () => {
	describe("with in-memory filesystem spec", () => {
		filesystemSpec(async () => ({
			sandbox: Sandbox.EnvInMemory.layer(),
		}));
	});

	// each layer build owns a fresh memory tree: nothing leaks between
	// independent sandboxes
	it("should isolate in-memory sandboxes with no leakage", async () => {
		await withService(
			async () => ({ sandbox: Sandbox.EnvInMemory.layer() }),
			(filesystem) => filesystem.writeFile("/file.txt", "first"),
		);

		const exists = await withService(
			async () => ({ sandbox: Sandbox.EnvInMemory.layer() }),
			(filesystem) => filesystem.exists("/file.txt"),
		);

		expect(exists).toBe(false);
	});

	// virtual sandboxes have no OS behind them: attempting to spawn a process
	// is a wiring mistake and dies with a defect instead of escaping the sandbox
	it("should refuse host process execution when `hostProcess` is disabled", async () => {
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
				return yield* Effect.scoped(spawner.spawn(ChildProcess.make("git", ["status"])));
			}).pipe(Effect.provide(Sandbox.EnvInMemory.layer())),
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
					sandbox: Sandbox.EnvInMemory.layer({ seed: { "/repo/package.json": "{}" }, readOnly: true }),
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
				async () => ({ sandbox: Sandbox.EnvInMemory.layer({ readOnly: true }) }),
				async (filesystem) => {
					await expect(filesystem.writeFile("/file.txt", "nope")).rejects.toBeDefined();
				},
			);
		});
	});
});
