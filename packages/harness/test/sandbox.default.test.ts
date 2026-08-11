import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { SandboxFileSystem } from "../src/sandbox/fs/filesystem.ts";
import { Local } from "../src/sandbox/fs/vfs.ts";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import { filesystemSpec, withService } from "./fixtures/sandbox.spec.ts";
import { tmpdir } from "./fixtures/tempdir.ts";

describe("Sandbox.EnvDefault", () => {
	// The host runs the same cross-backend contract as the virtual backends —
	// possible only now that the spec addresses the mount, since every path it
	// touches lands inside this temp directory instead of at the real root.
	filesystemSpec(async () => {
		const tmp = await tmpdir();
		return {
			sandbox: Sandbox.EnvNodeJSDefault.layer(),
			cwd: tmp.path,
			dispose: () => tmp[Symbol.asyncDispose](),
		};
	});

	it("should resolve relative file operations against cwd", async () => {
		await using tmp = await tmpdir();

		await withService(
			async () => ({ sandbox: Sandbox.EnvNodeJSDefault.layer(), cwd: tmp.path }),
			async (filesystem) => {
				await filesystem.writeFile("src/index.ts", "export const value = 1;\n");

				expect(await filesystem.readFile("src/index.ts")).toBe("export const value = 1;\n");
				expect(await filesystem.readFile(path.join(tmp.path, "src", "index.ts"))).toBe("export const value = 1;\n");
				expect(await filesystem.exists("src/index.ts")).toBe(true);
				expect((await filesystem.stat("src")).isDirectory).toBe(true);
			},
		);

		expect(await fs.readFile(path.join(tmp.path, "src", "index.ts"), "utf8")).toBe("export const value = 1;\n");
	});

	// The host is the backend production runs on and the one the shared
	// `filesystemSpec` cannot cover, because that spec writes to absolute `/…`
	// paths — safe inside a VFS, the real root here. So the two cross-backend
	// guarantees are pinned directly against a temp directory instead.
	it("should create missing parent directories on write", async () => {
		await using tmp = await tmpdir();

		await withService(
			async () => ({ sandbox: Sandbox.EnvNodeJSDefault.layer(), cwd: tmp.path }),
			async (filesystem) => {
				await filesystem.writeFile("deeply/nested/dir/file.txt", "data");

				expect(await filesystem.readFile("deeply/nested/dir/file.txt")).toBe("data");
				expect((await filesystem.stat("deeply/nested/dir")).isDirectory).toBe(true);
			},
		);

		expect(await fs.readFile(path.join(tmp.path, "deeply", "nested", "dir", "file.txt"), "utf8")).toBe("data");
	});

	it("should report symlink identity through lstat, never through stat", async () => {
		await using tmp = await tmpdir();
		await fs.writeFile(path.join(tmp.path, "target.txt"), "data");
		await fs.symlink("target.txt", path.join(tmp.path, "link.txt"));

		await withService(
			async () => ({ sandbox: Sandbox.EnvNodeJSDefault.layer(), cwd: tmp.path }),
			async (filesystem) => {
				// `stat` follows the link, so it describes the target — a regular file
				const target = await filesystem.stat("link.txt");
				expect(target.isFile).toBe(true);
				expect(target.isSymbolicLink).toBe(false);

				// `lstat` describes the entry itself, matching the remote backends
				expect(filesystem.lstat).toBeDefined();
				const entry = await filesystem.lstat!("link.txt");
				expect(entry.isSymbolicLink).toBe(true);
			},
		);
	});

	it("should see files created by the host under cwd", async () => {
		await using tmp = await tmpdir();
		await fs.writeFile(path.join(tmp.path, "host.txt"), "from host");

		const content = await withService(
			async () => ({ sandbox: Sandbox.EnvNodeJSDefault.layer(), cwd: tmp.path }),
			(filesystem) => filesystem.readFile("host.txt"),
		);

		expect(content).toBe("from host");
	});

	it("should reject an indeterminate existence probe instead of reporting absence", async () => {
		await using tmp = await tmpdir();
		const locked = path.join(tmp.path, "locked");
		await fs.mkdir(locked);
		await fs.writeFile(path.join(locked, "file.txt"), "present");
		await fs.chmod(locked, 0o000);

		try {
			await expect(
				withService(
					async () => ({ sandbox: Sandbox.EnvNodeJSDefault.layer(), cwd: tmp.path }),
					(filesystem) => filesystem.exists("locked/file.txt"),
				),
			).rejects.toMatchObject({ _tag: "SandboxFileSystemError", method: "exists" });
		} finally {
			await fs.chmod(locked, 0o700);
		}
	});

	it("should keep absolute file operations rooted at the host filesystem", async () => {
		await using tmp = await tmpdir();
		const cwd = path.join(tmp.path, "cwd");
		const absoluteFile = path.join(tmp.path, "absolute.txt");
		await fs.mkdir(cwd);

		await withService(
			async () => ({ sandbox: Sandbox.EnvNodeJSDefault.layer(), cwd }),
			async (filesystem) => {
				await filesystem.writeFile(absoluteFile, "absolute");

				expect(await filesystem.readFile(absoluteFile)).toBe("absolute");
				expect(await filesystem.exists("absolute.txt")).toBe(false);
			},
		);

		expect(await fs.readFile(absoluteFile, "utf8")).toBe("absolute");
		await expect(fs.access(path.join(cwd, "absolute.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("should follow host symlinks outside cwd", async () => {
		await using tmp = await tmpdir();
		const cwd = path.join(tmp.path, "cwd");
		const outside = path.join(tmp.path, "outside.txt");
		await fs.mkdir(cwd);
		await fs.writeFile(outside, "outside-secret");
		await fs.symlink(outside, path.join(cwd, "leak.txt"));

		const content = await withService(
			async () => ({ sandbox: Sandbox.EnvNodeJSDefault.layer(), cwd }),
			async (filesystem) => {
				await filesystem.writeFile("leak.txt", "changed");
				return filesystem.readFile("leak.txt");
			},
		);

		expect(content).toBe("changed");
		expect(await fs.readFile(outside, "utf8")).toBe("changed");
	});

	it("should preserve host symlink semantics through the VFS", async () => {
		await using tmp = await tmpdir();

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				// The raw VFS is the cwd-neutral transport, rooted at `/` — relative
				// paths here would resolve against the *process*, not the mount. Only
				// code above a mount may use them.
				const vfs = yield* Local.Vfs;
				const target = path.join(tmp.path, "target.txt");
				const link = path.join(tmp.path, "link.txt");
				yield* Effect.promise(async () => {
					await vfs.promises.writeFile(target, "inside");
					await vfs.promises.symlink("target.txt", link);
				});

				return {
					content: yield* Effect.promise(() => vfs.promises.readFile(link, "utf8")),
					target: yield* Effect.promise(() => vfs.promises.readlink(link)),
				};
			}).pipe(Effect.provide(Sandbox.EnvNodeJSDefault.layer())),
		);

		expect(result).toEqual({ content: "inside", target: "target.txt" });
		expect(await fs.readlink(path.join(tmp.path, "link.txt"))).toBe("target.txt");
	});

	it("should expose the same real host filesystem to host processes", async () => {
		await using tmp = await tmpdir();
		const marker = "process-marker.txt";
		const hostPath = path.join(tmp.path, marker);

		const output = await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* SandboxFileSystem.Service;
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

				yield* filesystem.writeFile(marker, "sandbox-data");

				const command = ChildProcess.make(
					process.execPath,
					["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", hostPath],
					{ stdin: "ignore" },
				);
				return yield* spawner.string(command);
			}).pipe(Effect.provide(Sandbox.defaultLayer(tmp.path))),
		);

		expect(output).toBe("sandbox-data");
	});

	it("should expose the VFS that backs the mounted filesystem", async () => {
		await using tmp = await tmpdir();
		const marker = path.join(tmp.path, "transport-marker.txt");
		await fs.writeFile(marker, "from disk");

		const content = await Effect.runPromise(
			Effect.gen(function* () {
				const vfs = yield* Local.Vfs;
				const filesystem = yield* SandboxFileSystem.Service;
				const provider = vfs.provider;
				const readFile = provider.readFile.bind(provider);
				provider.readFile = (filePath, options) =>
					filePath === marker ? Promise.resolve("from exposed VFS") : readFile(filePath, options);

				return yield* filesystem
					.readFile("transport-marker.txt")
					.pipe(Effect.ensuring(Effect.sync(() => (provider.readFile = readFile))));
			}).pipe(Effect.provide(Sandbox.defaultLayer(tmp.path))),
		);

		expect(content).toBe("from exposed VFS");
	});
});
