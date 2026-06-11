import { Cause, Effect, Exit } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vite-plus/test";
import { FileSystemError, Service } from "../src/filesystem/filesystem";
import { Sandbox } from "../src/sandbox/sandbox";
import { filesystemSpec } from "./fixtures/sandbox.spec";

describe("Sandbox.EnvInMemory", () => {
	filesystemSpec(async () => ({
		sandbox: Sandbox.EnvInMemory.layer(),
	}));

	// each layer build owns a fresh memory tree: nothing leaks between
	// independent sandboxes
	it("isolates separate in-memory sandboxes", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* Service;
				yield* filesystem.writeFileString("/file.txt", "first");
			}).pipe(Effect.provide(Sandbox.services(Sandbox.EnvInMemory.layer()))),
		);

		const exists = await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* Service;
				return yield* filesystem.exists("/file.txt");
			}).pipe(Effect.provide(Sandbox.services(Sandbox.EnvInMemory.layer()))),
		);

		expect(exists).toBe(false);
	});

	// virtual sandboxes have no OS behind them: attempting to spawn a process
	// is a wiring mistake and dies with a defect instead of escaping the sandbox
	it("refuses process execution", async () => {
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

	describe("read-only", () => {
		it("rejects writes when created with readOnly", async () => {
			const error = await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;
					return yield* filesystem.writeFileString("/file.txt", "nope").pipe(Effect.flip);
				}).pipe(Effect.provide(Sandbox.services(Sandbox.EnvInMemory.layer({ readOnly: true })))),
			);

			expect(error).toBeInstanceOf(FileSystemError);
			expect(error.method).toBe("writeFileString");
			expect(error.cause).toBeDefined();
		});

		it("still serves reads when read-only", async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;

					expect(yield* filesystem.isDir("/")).toBe(true);
					expect(yield* filesystem.exists("/")).toBe(true);
					expect(yield* filesystem.exists("/missing.txt")).toBe(false);
				}).pipe(Effect.provide(Sandbox.services(Sandbox.EnvInMemory.layer({ readOnly: true })))),
			);
		});

		it("allows writes by default", async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;

					yield* filesystem.writeFileString("/file.txt", "writable");

					expect(yield* filesystem.readFileString("/file.txt")).toBe("writable");
				}).pipe(Effect.provide(Sandbox.services(Sandbox.EnvInMemory.layer()))),
			);
		});
	});
});
