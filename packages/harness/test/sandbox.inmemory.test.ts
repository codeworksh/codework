import { Cause, Effect, Exit, Layer } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import { filesystemSpec, withService } from "./fixtures/sandbox.spec.ts";
import { tmpdir } from "./fixtures/tempdir.ts";

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

	it("should expose initialization failures in the typed error channel", async () => {
		const error = await Effect.runPromise(
			Layer.build(Sandbox.EnvInMemory.layer({ cwd: "relative" })).pipe(Effect.scoped, Effect.flip),
		);

		expect(error).toBeInstanceOf(Sandbox.EnvInMemory.InMemoryError);
		expect(error).toMatchObject({
			_tag: "InMemoryError",
			message: "Failed to initialize the in-memory filesystem",
		});
		expect(error.cause).toBeInstanceOf(TypeError);
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

	// hostProcess opts out of the refusal: the filesystem stays virtual but
	// child processes run on the host OS
	it("should spawn host processes when `hostProcess` is enabled", async () => {
		const exitCode = await Effect.runPromise(
			Effect.gen(function* () {
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
				return yield* spawner.exitCode(ChildProcess.make("echo", ["hello"]));
			}).pipe(Effect.provide(Sandbox.EnvInMemory.layer({ hostProcess: true }))),
		);

		expect(exitCode).toBe(0);
	});

	it("should allow host filesystem access when `hostProcess` is enabled", async () => {
		await using tmp = await tmpdir();
		const hostFile = path.join(tmp.path, "host.txt");
		await fs.writeFile(hostFile, "host-data");

		const output = await Effect.runPromise(
			Effect.gen(function* () {
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
				const command = ChildProcess.make(
					process.execPath,
					["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", hostFile],
					{ stdin: "ignore" },
				);
				return yield* spawner.string(command);
			}).pipe(Effect.provide(Sandbox.EnvInMemory.layer({ hostProcess: true }))),
		);

		expect(output).toBe("host-data");
	});

	describe("with seed", () => {
		it("should write inline seed files before the sandbox is used", async () => {
			await withService(
				async () => ({
					sandbox: Sandbox.EnvInMemory.layer({
						seed: {
							"/repo/package.json": "{}",
							"/repo/src/index.ts": "export const value = 1;\n",
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
					sandbox: Sandbox.EnvInMemory.layer({ cwd: "/repo", seed: { "package.json": "{}" } }),
					cwd: "/repo",
				}),
				async (filesystem) => {
					expect(await filesystem.readFile("package.json")).toBe("{}");
					expect(await filesystem.readFile("/repo/package.json")).toBe("{}");
					expect(await filesystem.exists("/package.json")).toBe(false);
				},
			);
		});

		it("should copy host directory into the requested target", async () => {
			await using tmp = await tmpdir();
			const fixture = path.join(tmp.path, "basic-project");
			await fs.mkdir(path.join(fixture, "src"), { recursive: true });
			await fs.writeFile(path.join(fixture, "package.json"), "{}");
			await fs.writeFile(path.join(fixture, "src", "index.ts"), "export const value = 1;\n");

			await withService(
				async () => ({
					sandbox: Sandbox.EnvInMemory.layer({ seedFromDirectory: { path: fixture, target: "/repo" } }),
				}),
				async (filesystem) => {
					expect(await filesystem.readFile("/repo/package.json")).toBe("{}");
					expect(await filesystem.readFile("/repo/src/index.ts")).toBe("export const value = 1;\n");
				},
			);
		});

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

	describe("with cwd", () => {
		it("should resolve relative file operations against cwd", async () => {
			await withService(
				async () => ({ sandbox: Sandbox.EnvInMemory.layer({ cwd: "/repo" }), cwd: "/repo" }),
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

		it("should keep absolute file operations rooted at the sandbox root", async () => {
			await withService(
				async () => ({ sandbox: Sandbox.EnvInMemory.layer({ cwd: "/repo" }), cwd: "/repo" }),
				async (filesystem) => {
					await filesystem.writeFile("/absolute.txt", "absolute");

					expect(await filesystem.readFile("/absolute.txt")).toBe("absolute");
					expect(await filesystem.exists("absolute.txt")).toBe(false);
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

		it("should still serve reads when read-only", async () => {
			await withService(
				async () => ({ sandbox: Sandbox.EnvInMemory.layer({ readOnly: true }) }),
				async (filesystem) => {
					expect((await filesystem.stat("/")).isDirectory).toBe(true);
					expect(await filesystem.exists("/")).toBe(true);
					expect(await filesystem.exists("/missing.txt")).toBe(false);
				},
			);
		});

		it("should allow writes by default", async () => {
			await withService(
				async () => ({ sandbox: Sandbox.EnvInMemory.layer() }),
				async (filesystem) => {
					await filesystem.writeFile("/file.txt", "writable");
					expect(await filesystem.readFile("/file.txt")).toBe("writable");
				},
			);
		});
	});
});
