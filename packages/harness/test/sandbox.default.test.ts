import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { FileSystemError, Service, Vfs } from "../src/filesystem/filesystem";
import { Sandbox } from "../src/sandbox/sandbox";
import { filesystemSpec } from "./fixtures/sandbox.spec";
import { tmpdir } from "./fixtures/tempdir";

describe("Sandbox.EnvDefault", () => {
	filesystemSpec(async () => {
		const tmp = await tmpdir();
		return {
			sandbox: Sandbox.EnvDefault.layer(tmp.path),
			dispose: () => tmp[Symbol.asyncDispose](),
		};
	});

	// EnvDefault is rooted at a host directory: writes through the sandbox
	// must land on the real filesystem, and vice versa.
	it("writes through to the real filesystem under the configured root", async () => {
		await using tmp = await tmpdir();

		await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* Service;
				yield* filesystem.writeFileString("/file.txt", "hello");
			}).pipe(Effect.provide(Sandbox.services(Sandbox.EnvDefault.layer(tmp.path)))),
		);

		expect(await fs.readFile(path.join(tmp.path, "file.txt"), "utf8")).toBe("hello");
	});

	it("sees files created on the real filesystem", async () => {
		await using tmp = await tmpdir();
		await fs.writeFile(path.join(tmp.path, "host.txt"), "from host");

		const content = await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* Service;
				return yield* filesystem.readFileString("/host.txt");
			}).pipe(Effect.provide(Sandbox.services(Sandbox.EnvDefault.layer(tmp.path)))),
		);

		expect(content).toBe("from host");
	});

	it("keeps safe virtual symlinks inside the configured root", async () => {
		await using tmp = await tmpdir();

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const vfs = yield* Vfs;
				yield* Effect.promise(async () => {
					await vfs.promises.writeFile("/target.txt", "inside");
					await vfs.promises.symlink("/target.txt", "/link.txt");
				});

				return {
					content: yield* Effect.promise(() => vfs.promises.readFile("/link.txt", "utf8")),
					target: yield* Effect.promise(() => vfs.promises.readlink("/link.txt")),
				};
			}).pipe(Effect.provide(Sandbox.EnvDefault.layer(tmp.path))),
		);

		expect(result).toEqual({ content: "inside", target: "/target.txt" });
		expect(await fs.readFile(path.join(tmp.path, "link.txt"), "utf8")).toBe("inside");
	});

	it("rejects host symlinks that resolve outside the configured root", async () => {
		await using tmp = await tmpdir();
		const outside = path.join(path.dirname(tmp.path), `${path.basename(tmp.path)}-secret.txt`);
		await fs.writeFile(outside, "outside-secret");
		await fs.symlink(outside, path.join(tmp.path, "leak.txt"));

		try {
			const errors = await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;
					return {
						read: yield* filesystem.readFileString("/leak.txt").pipe(Effect.flip),
						write: yield* filesystem.writeFileString("/leak.txt", "changed").pipe(Effect.flip),
					};
				}).pipe(Effect.provide(Sandbox.services(Sandbox.EnvDefault.layer(tmp.path)))),
			);

			expect(errors.read).toBeInstanceOf(FileSystemError);
			expect((errors.read.cause as NodeJS.ErrnoException).code).toBe("EACCES");
			expect(errors.write).toBeInstanceOf(FileSystemError);
			expect((errors.write.cause as NodeJS.ErrnoException).code).toBe("EACCES");
			expect(await fs.readFile(outside, "utf8")).toBe("outside-secret");
		} finally {
			await fs.rm(outside, { force: true });
		}
	});

	it("exposes host processes as a separate, explicit namespace", async () => {
		await using tmp = await tmpdir();
		const marker = "process-marker.txt";

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* Service;
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
				yield* filesystem.writeFileString(`/${marker}`, "sandbox-data");

				const read = (target: string) =>
					Effect.scoped(
						Effect.gen(function* () {
							const handle = yield* spawner.spawn(
								ChildProcess.make(
									process.execPath,
									[
										"-e",
										"process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))",
										target,
									],
									{ stdin: "ignore" },
								),
							);
							return yield* Effect.all(
								{
									exitCode: handle.exitCode,
									stdout: handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
								},
								{ concurrency: "unbounded" },
							);
						}),
					);

				return {
					hostPath: yield* read(path.join(tmp.path, marker)),
					virtualPath: yield* read(`/${marker}`),
				};
			}).pipe(Effect.provide(Sandbox.defaultLayer(tmp.path))),
		);

		expect(result.hostPath).toEqual({ exitCode: 0, stdout: "sandbox-data" });
		expect(result.virtualPath.exitCode).not.toBe(0);
		expect(result.virtualPath.stdout).toBe("");
	});
});
