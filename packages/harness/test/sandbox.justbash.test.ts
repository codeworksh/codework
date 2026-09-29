import { create, MemoryProvider, RealFSProvider } from "@platformatic/vfs";
import { Effect } from "effect";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { bridge, EnvBash } from "../src/sandbox/shell/justbash.ts";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import { filesystemSpec } from "./fixtures/sandbox.spec.ts";
import { tmpdir } from "./fixtures/tempdir.ts";

describe("Sandbox.EnvBash", () => {
	// wrapping a sandbox must not change its filesystem semantics
	filesystemSpec(async () => ({
		sandbox: Sandbox.EnvBash.layer(Sandbox.EnvInMemory.layer(), "/"),
	}));

	describe("shell and FileSystem.Service share one filesystem", () => {
		const sandbox = () =>
			Sandbox.EnvBash.services(Sandbox.EnvInMemory.layer(), Sandbox.SandboxIO.virtual({ driver: "memory" }));

		it("tracks executable mode across moves", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const shell = yield* EnvBash.Shell;
					return yield* shell.exec(
						'printf "#!/bin/sh\\necho executable\\n" > /script && chmod +x /script && mv /script /moved && /moved',
					);
				}).pipe(Effect.provide(sandbox())),
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("executable\n");
		});

		it("tracks executable mode across copies", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const shell = yield* EnvBash.Shell;
					return yield* shell.exec(
						'printf "#!/bin/sh\\necho executable\\n" > /script && chmod +x /script && cp /script /copy && /copy',
					);
				}).pipe(Effect.provide(sandbox())),
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("executable\n");
		});

		it("fails hard links explicitly", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const shell = yield* EnvBash.Shell;
					return yield* shell.exec("echo data > /source && ln /source /link");
				}).pipe(Effect.provide(sandbox())),
			);

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("hard links are not supported");
		});
	});

	describe("bridge metadata", () => {
		it("shares chmod and utimes metadata between bridges over one VFS", async () => {
			const vfs = create(new MemoryProvider(), { moduleHooks: false });
			await vfs.promises.writeFile("/file.txt", "data");
			const first = bridge(vfs, "/alpha");
			const second = bridge(vfs, "/beta");
			const mtime = new Date("2020-01-02T03:04:05.000Z");

			await first.chmod("/file.txt", 0o751);
			await first.utimes("/file.txt", mtime, mtime);
			const stat = await second.stat("/file.txt");

			expect(stat.mode & 0o777).toBe(0o751);
			expect(stat.mtime).toEqual(mtime);
		});

		it("keys metadata by the VFS-resolved cwd path", async () => {
			const vfs = create(new MemoryProvider(), { moduleHooks: false, virtualCwd: true });
			await vfs.promises.mkdir("/repo");
			vfs.chdir("/repo");
			const filesystem = bridge(vfs, "/");

			await filesystem.writeFile("file.txt", "data");
			await filesystem.chmod("file.txt", 0o751);

			expect((await filesystem.stat("file.txt")).mode & 0o777).toBe(0o751);
			expect((await filesystem.stat("/repo/file.txt")).mode & 0o777).toBe(0o751);
		});

		it("applies metadata changes through symbolic links to their target", async () => {
			const vfs = create(new MemoryProvider(), { moduleHooks: false });
			await vfs.promises.writeFile("/target.txt", "data");
			await vfs.promises.symlink("/target.txt", "/link.txt");
			const filesystem = bridge(vfs, "/");

			await filesystem.chmod("/link.txt", 0o750);

			expect((await filesystem.stat("/target.txt")).mode & 0o777).toBe(0o750);
			expect((await filesystem.stat("/link.txt")).mode & 0o777).toBe(0o750);
			expect((await filesystem.lstat("/link.txt")).isSymbolicLink).toBe(true);
		});

		it("refreshes an overlaid mtime when the file is written again", async () => {
			const vfs = create(new MemoryProvider(), { moduleHooks: false });
			await vfs.promises.writeFile("/file.txt", "data");
			const filesystem = bridge(vfs, "/");
			const past = new Date("2020-01-02T03:04:05.000Z");
			await filesystem.chmod("/file.txt", 0o755);

			await filesystem.utimes("/file.txt", past, past);
			await filesystem.writeFile("/file.txt", "rewritten");
			const written = await filesystem.stat("/file.txt");

			await filesystem.utimes("/file.txt", past, past);
			await filesystem.appendFile("/file.txt", " more");
			const appended = await filesystem.stat("/file.txt");

			expect(written.mtime.getTime()).toBeGreaterThan(past.getTime());
			expect(appended.mtime.getTime()).toBeGreaterThan(past.getTime());
			// the mode override is untouched by writes
			expect(appended.mode & 0o777).toBe(0o755);
		});

		it("rejects metadata changes on a read-only provider", async () => {
			const provider = new MemoryProvider();
			const vfs = create(provider, { moduleHooks: false });
			await vfs.promises.writeFile("/file.txt", "data");
			provider.setReadOnly();
			const filesystem = bridge(vfs, "/");

			await expect(filesystem.chmod("/file.txt", 0o755)).rejects.toMatchObject({ code: "EROFS" });
			await expect(filesystem.utimes("/file.txt", new Date(), new Date())).rejects.toMatchObject({ code: "EROFS" });
		});
	});

	describe("bridge rm", () => {
		it("ignores only missing paths under force", async () => {
			const filesystem = bridge(create(new MemoryProvider(), { moduleHooks: false }), "/");

			await expect(filesystem.rm("/missing.txt", { force: true })).resolves.toBeUndefined();
			await expect(filesystem.rm("/missing.txt")).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("propagates provider failures despite force", async () => {
			const vfs = create(new MemoryProvider(), { moduleHooks: false });
			await vfs.promises.writeFile("/file.txt", "data");
			const denied = Object.assign(new Error("EACCES: permission denied, lstat '/file.txt'"), {
				code: "EACCES",
			});
			const failing = Object.create(vfs, {
				promises: { value: { ...vfs.promises, lstat: () => Promise.reject(denied) } },
			}) as typeof vfs;

			await expect(bridge(failing, "/").rm("/file.txt", { force: true })).rejects.toMatchObject({ code: "EACCES" });
		});
	});

	describe("bridge path enumeration", () => {
		it("walks only the mount directory for the real filesystem provider", async () => {
			await using tmp = await tmpdir();
			await fs.writeFile(path.join(tmp.path, "a.txt"), "a");

			// The bridge takes the directory explicitly: the VFS is the shared
			// transport and stays rooted at `/`, so enumerating from its own cwd
			// would walk the entire machine for every `*`.
			const vfs = create(new RealFSProvider("/"), { moduleHooks: false, virtualCwd: true });

			const paths = bridge(vfs, tmp.path).getAllPaths();

			expect(paths).toContain(path.join(tmp.path, "a.txt"));
			expect(paths.every((item) => item === tmp.path || item.startsWith(`${tmp.path}/`))).toBe(true);
		});
	});
});
