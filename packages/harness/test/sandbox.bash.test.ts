import { create, MemoryProvider } from "@platformatic/vfs";
import { Effect } from "effect";
import { Bash } from "just-bash";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Service } from "../src/filesystem/filesystem";
import { bridge, EnvBash } from "../src/sandbox/bash";
import { Sandbox } from "../src/sandbox/sandbox";
import { filesystemSpec } from "./fixtures/sandbox.spec";
import { tmpdir } from "./fixtures/tempdir";

describe("Sandbox.EnvBash", () => {
	// wrapping a sandbox must not change its filesystem semantics
	filesystemSpec(async () => ({
		sandbox: Sandbox.EnvBash.layer(Sandbox.EnvInMemory.layer()),
	}));

	describe("shell and FileSystem.Service share one filesystem", () => {
		const sandbox = () => Sandbox.EnvBash.services(Sandbox.EnvInMemory.layer());

		it("shell reads what the service wrote", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;
					const shell = yield* EnvBash.Shell;

					yield* filesystem.writeFileString("/file.txt", "from service");

					return yield* shell.exec("cat /file.txt");
				}).pipe(Effect.provide(sandbox())),
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("from service");
		});

		it("service reads what the shell wrote", async () => {
			const content = await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;
					const shell = yield* EnvBash.Shell;

					const result = yield* shell.exec('mkdir -p /workspace && echo "from shell" > /workspace/file.txt');
					expect(result.exitCode).toBe(0);

					return yield* filesystem.readFileString("/workspace/file.txt");
				}).pipe(Effect.provide(sandbox())),
			);

			expect(content).toBe("from shell\n");
		});

		it("runs pipelines over service-written files", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;
					const shell = yield* EnvBash.Shell;

					yield* filesystem.writeFileString("/data.txt", "alpha\nbeta\ngamma\nbeta\n");

					return yield* shell.exec("cat /data.txt | grep beta | wc -l");
				}).pipe(Effect.provide(sandbox())),
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe("2");
		});

		it("reports failures through exit codes", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const shell = yield* EnvBash.Shell;
					return yield* shell.exec("cat /missing.txt");
				}).pipe(Effect.provide(sandbox())),
			);

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("missing.txt");
		});

		it("applies per-exec environment without leaking it to the next call", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const shell = yield* EnvBash.Shell;
					const configured = yield* shell.exec('printf "%s" "$SANDBOX_VALUE"', {
						env: { SANDBOX_VALUE: "configured" },
					});
					const reset = yield* shell.exec('printf "%s" "${SANDBOX_VALUE-unset}"');
					return { configured, reset };
				}).pipe(Effect.provide(sandbox())),
			);

			expect(result.configured.stdout).toBe("configured");
			expect(result.reset.stdout).toBe("unset");
		});

		it("copies, moves, and removes directory trees", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;
					const shell = yield* EnvBash.Shell;

					yield* filesystem.writeFileString("/source/nested/file.txt", "data");
					const exec = yield* shell.exec(
						"cp -r /source /copy && mv /copy/nested/file.txt /copy/moved.txt && rm -r /source",
					);

					return {
						exec,
						content: yield* filesystem.readFileString("/copy/moved.txt"),
						sourceExists: yield* filesystem.exists("/source"),
					};
				}).pipe(Effect.provide(sandbox())),
			);

			expect(result.exec.exitCode).toBe(0);
			expect(result.content).toBe("data");
			expect(result.sourceExists).toBe(false);
		});

		it("supports symbolic links and virtual absolute targets", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;
					const shell = yield* EnvBash.Shell;
					yield* filesystem.writeFileString("/target.txt", "linked");

					return yield* shell.exec("ln -s /target.txt /link.txt && readlink /link.txt && cat /link.txt");
				}).pipe(Effect.provide(sandbox())),
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("/target.txt\nlinked");
		});

		it("uses the complete VFS tree for glob expansion", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;
					const shell = yield* EnvBash.Shell;
					yield* filesystem.writeFileString("/workspace/a.txt", "a");
					yield* filesystem.writeFileString("/workspace/b.txt", "b");
					yield* filesystem.writeFileString("/workspace/c.json", "c");

					return yield* shell.exec("ls /workspace/*.txt");
				}).pipe(Effect.provide(sandbox())),
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim().split("\n").filter(Boolean)).toEqual(["/workspace/a.txt", "/workspace/b.txt"]);
		});

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
		it("applies chmod and utimes through a shell-local metadata overlay", async () => {
			const vfs = create(new MemoryProvider(), { moduleHooks: false });
			await vfs.promises.writeFile("/file.txt", "data");
			const filesystem = bridge(vfs);
			const mtime = new Date("2020-01-02T03:04:05.000Z");

			await filesystem.chmod("/file.txt", 0o751);
			await filesystem.utimes("/file.txt", mtime, mtime);
			const stat = await filesystem.stat("/file.txt");

			expect(stat.mode & 0o777).toBe(0o751);
			expect(stat.mtime).toEqual(mtime);
		});

		it("applies metadata changes through symbolic links to their target", async () => {
			const vfs = create(new MemoryProvider(), { moduleHooks: false });
			await vfs.promises.writeFile("/target.txt", "data");
			await vfs.promises.symlink("/target.txt", "/link.txt");
			const filesystem = bridge(vfs);

			await filesystem.chmod("/link.txt", 0o750);

			expect((await filesystem.stat("/target.txt")).mode & 0o777).toBe(0o750);
			expect((await filesystem.stat("/link.txt")).mode & 0o777).toBe(0o750);
			expect((await filesystem.lstat("/link.txt")).isSymbolicLink).toBe(true);
		});

		it("rejects metadata changes for missing paths", async () => {
			const filesystem = bridge(create(new MemoryProvider(), { moduleHooks: false }));

			await expect(filesystem.chmod("/missing.txt", 0o755)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(filesystem.utimes("/missing.txt", new Date(), new Date())).rejects.toMatchObject({
				code: "ENOENT",
			});
		});

		it("rejects metadata changes on a read-only provider", async () => {
			const provider = new MemoryProvider();
			const vfs = create(provider, { moduleHooks: false });
			await vfs.promises.writeFile("/file.txt", "data");
			provider.setReadOnly();
			const filesystem = bridge(vfs);

			await expect(filesystem.chmod("/file.txt", 0o755)).rejects.toMatchObject({ code: "EROFS" });
			await expect(filesystem.utimes("/file.txt", new Date(), new Date())).rejects.toMatchObject({ code: "EROFS" });
		});

		it("surfaces read-only metadata failures through bash exit codes", async () => {
			const provider = new MemoryProvider();
			const vfs = create(provider, { moduleHooks: false });
			await vfs.promises.writeFile("/file.txt", "data");
			provider.setReadOnly();
			const bash = new Bash({ fs: bridge(vfs), cwd: "/" });

			const chmod = await bash.exec("chmod 755 /file.txt");
			const touch = await bash.exec("touch /file.txt");

			expect(chmod.exitCode).not.toBe(0);
			expect(touch.exitCode).not.toBe(0);
		});
	});

	// the wrapper composes with any vfs backend: shell writes through to a
	// sqlite-backed filesystem and survive sandbox lifetimes
	it("works over the sqldb backend with persistence", async () => {
		await using tmp = await tmpdir();
		const database = path.join(tmp.path, "fs.db");

		await Effect.runPromise(
			Effect.gen(function* () {
				const shell = yield* EnvBash.Shell;
				const result = yield* shell.exec('echo "persisted by bash" > /file.txt');
				expect(result.exitCode).toBe(0);
			}).pipe(Effect.provide(Sandbox.EnvBash.services(Sandbox.EnvSqldb.layer(database)))),
		);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const shell = yield* EnvBash.Shell;
				return yield* shell.exec("cat /file.txt");
			}).pipe(Effect.provide(Sandbox.EnvBash.services(Sandbox.EnvSqldb.layer(database)))),
		);

		expect(result.stdout).toBe("persisted by bash\n");
	});

	// and over the default backend: bash output lands on the real disk
	it("works over the default backend", async () => {
		await using tmp = await tmpdir();

		const content = await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* Service;
				const shell = yield* EnvBash.Shell;

				const result = yield* shell.exec('echo "real disk" > /file.txt');
				expect(result.exitCode).toBe(0);

				return yield* filesystem.readFileString("/file.txt");
			}).pipe(Effect.provide(Sandbox.EnvBash.services(Sandbox.EnvDefault.layer(tmp.path)))),
		);

		expect(content).toBe("real disk\n");
	});

	it("cannot escape the default backend through an absolute symlink", async () => {
		await using tmp = await tmpdir();
		const outside = path.join(path.dirname(tmp.path), `${path.basename(tmp.path)}-secret.txt`);
		await fs.writeFile(outside, "outside-secret");

		try {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const shell = yield* EnvBash.Shell;
					return yield* shell.exec(`ln -s ${outside} /leak && cat /leak`);
				}).pipe(Effect.provide(Sandbox.EnvBash.services(Sandbox.EnvDefault.layer(tmp.path)))),
			);

			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).not.toContain("outside-secret");
		} finally {
			await fs.rm(outside, { force: true });
		}
	});
});
