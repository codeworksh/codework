import { Cause, Effect, Exit } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { FileSystemError, Service } from "../src/filesystem/filesystem";
import { Sandbox } from "../src/sandbox/sandbox";
import { filesystemSpec } from "./fixtures/sandbox.spec";
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

			await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;
					yield* filesystem.writeFileString("/file.txt", "persisted");
				}).pipe(Effect.provide(Sandbox.services(Sandbox.EnvSqldb.layer({ location: database })))),
			);

			const content = await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;
					return yield* filesystem.readFileString("/file.txt");
				}).pipe(Effect.provide(Sandbox.services(Sandbox.EnvSqldb.layer({ location: database })))),
			);

			expect(content).toBe("persisted");
		});
	});

	// each in-memory sandbox owns its own database: nothing leaks between
	// independent layer builds
	it("should isolate in-memory sandboxes with no leakage", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* Service;
				yield* filesystem.writeFileString("/file.txt", "first");
			}).pipe(Effect.provide(Sandbox.services(Sandbox.EnvSqldb.layer()))),
		);

		const exists = await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* Service;
				return yield* filesystem.exists("/file.txt");
			}).pipe(Effect.provide(Sandbox.services(Sandbox.EnvSqldb.layer()))),
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
			}).pipe(Effect.provide(Sandbox.EnvSqldb.layer({ options: { hostProcess: true } }))),
		);

		expect(output).toBe("host-data");
	});

	describe("with seed", () => {
		it("should write inline seed files before the sandbox is used", async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;

					expect(yield* filesystem.readFileString("/repo/package.json")).toBe("{}");
					expect(yield* filesystem.readFileString("/repo/src/index.ts")).toBe("export const value = 1;\n");
				}).pipe(
					Effect.provide(
						Sandbox.services(
							Sandbox.EnvSqldb.layer({
								options: {
									seed: {
										"/repo/package.json": "{}",
										"/repo/src/index.ts": "export const value = 1;\n",
									},
								},
							}),
						),
					),
				),
			);
		});

		it("should resolve relative seed paths against cwd", async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;

					expect(yield* filesystem.readFileString("package.json")).toBe("{}");
					expect(yield* filesystem.readFileString("/repo/package.json")).toBe("{}");
					expect(yield* filesystem.exists("/package.json")).toBe(false);
				}).pipe(
					Effect.provide(
						Sandbox.services(
							Sandbox.EnvSqldb.layer({
								options: {
									cwd: "/repo",
									seed: {
										"package.json": "{}",
									},
								},
							}),
						),
					),
				),
			);
		});

		it("should copy host directory into the requested target", async () => {
			await using tmp = await tmpdir();
			const fixture = path.join(tmp.path, "basic-project");
			await fs.mkdir(path.join(fixture, "src"), { recursive: true });
			await fs.writeFile(path.join(fixture, "package.json"), "{}");
			await fs.writeFile(path.join(fixture, "src", "index.ts"), "export const value = 1;\n");

			await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;

					expect(yield* filesystem.readFileString("/repo/package.json")).toBe("{}");
					expect(yield* filesystem.readFileString("/repo/src/index.ts")).toBe("export const value = 1;\n");
				}).pipe(
					Effect.provide(
						Sandbox.services(
							Sandbox.EnvSqldb.layer({
								options: {
									seedFromDirectory: {
										path: fixture,
										target: "/repo",
									},
								},
							}),
						),
					),
				),
			);
		});

		it("should copy a host directory into cwd when target is omitted", async () => {
			await using tmp = await tmpdir();
			const fixture = path.join(tmp.path, "basic-project");
			await fs.mkdir(path.join(fixture, "src"), { recursive: true });
			await fs.writeFile(path.join(fixture, "package.json"), "{}");
			await fs.writeFile(path.join(fixture, "src", "index.ts"), "export const value = 1;\n");

			await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;

					expect(yield* filesystem.readFileString("package.json")).toBe("{}");
					expect(yield* filesystem.readFileString("/repo/src/index.ts")).toBe("export const value = 1;\n");
					expect(yield* filesystem.exists("/package.json")).toBe(false);
				}).pipe(
					Effect.provide(
						Sandbox.services(
							Sandbox.EnvSqldb.layer({
								options: {
									cwd: "/repo",
									seedFromDirectory: {
										path: fixture,
									},
								},
							}),
						),
					),
				),
			);
		});

		it("should freeze seeded files when readOnly is enabled", async () => {
			const error = await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;

					expect(yield* filesystem.readFileString("/repo/package.json")).toBe("{}");
					return yield* filesystem.writeFileString("/repo/other.txt", "nope").pipe(Effect.flip);
				}).pipe(
					Effect.provide(
						Sandbox.services(
							Sandbox.EnvSqldb.layer({
								options: {
									seed: {
										"/repo/package.json": "{}",
									},
									readOnly: true,
								},
							}),
						),
					),
				),
			);

			expect(error).toBeInstanceOf(FileSystemError);
		});
	});

	describe("with cwd", () => {
		it("should resolve relative file operations against cwd", async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;

					yield* filesystem.writeFileString("src/index.ts", "export const value = 1;\n");

					expect(yield* filesystem.readFileString("src/index.ts")).toBe("export const value = 1;\n");
					expect(yield* filesystem.readFileString("/repo/src/index.ts")).toBe("export const value = 1;\n");
					expect(yield* filesystem.exists("src/index.ts")).toBe(true);
					expect(yield* filesystem.exists("/src/index.ts")).toBe(false);
					expect(yield* filesystem.isDir("src")).toBe(true);
				}).pipe(Effect.provide(Sandbox.services(Sandbox.EnvSqldb.layer({ options: { cwd: "/repo" } })))),
			);
		});

		it("should keep absolute file operations rooted at the sandbox root", async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;

					yield* filesystem.writeFileString("/absolute.txt", "absolute");

					expect(yield* filesystem.readFileString("/absolute.txt")).toBe("absolute");
					expect(yield* filesystem.exists("absolute.txt")).toBe(false);
				}).pipe(Effect.provide(Sandbox.services(Sandbox.EnvSqldb.layer({ options: { cwd: "/repo" } })))),
			);
		});
	});

	describe("with read only", () => {
		it("should reject writes when created with readOnly", async () => {
			const error = await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;
					return yield* filesystem.writeFileString("/file.txt", "nope").pipe(Effect.flip);
				}).pipe(Effect.provide(Sandbox.services(Sandbox.EnvSqldb.layer({ options: { cwd: "/repo" } })))),
			);

			expect(error).toBeInstanceOf(FileSystemError);
			expect(error.method).toBe("writeFileString");
			expect(error.cause).toBeDefined();
		});

		it("should still serves reads when read-only", async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;

					expect(yield* filesystem.isDir("/")).toBe(true);
					expect(yield* filesystem.exists("/")).toBe(true);
					expect(yield* filesystem.exists("/missing.txt")).toBe(false);
				}).pipe(Effect.provide(Sandbox.services(Sandbox.EnvSqldb.layer({ options: { cwd: "/repo" } })))),
			);
		});

		it("should allow writes by default", async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;

					yield* filesystem.writeFileString("/file.txt", "writable");

					expect(yield* filesystem.readFileString("/file.txt")).toBe("writable");
				}).pipe(Effect.provide(Sandbox.services(Sandbox.EnvSqldb.layer()))),
			);
		});
	});
});
