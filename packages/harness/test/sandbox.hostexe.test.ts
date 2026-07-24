import { Effect } from "effect";
import { realpath } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import { SandboxFileSystem } from "../src/sandbox/filesystem/filesystem";
import { Sandbox } from "../src/sandbox/sandbox";
import { Shell } from "../src/sandbox/shell";
import { tmpdir } from "./fixtures/tempdir";

// The shell and the filesystem are two halves of one sandbox: a relative path
// must mean the same thing to both. Before the shell took its cwd from the
// paired VFS, commands ran in the harness's own checkout while writes landed in
// the sandbox — so a command could read or mutate the wrong tree entirely.
describe("Sandbox.defaultLayer — shell and filesystem share a cwd", () => {
	it("runs commands in the sandbox cwd, not the harness process cwd", async () => {
		await using tmp = await tmpdir();
		// macOS resolves /var through a symlink, which `pwd` reports resolved.
		const root = await realpath(tmp.path);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const shell = yield* Shell;
				return {
					viaExec: (yield* shell.exec("pwd")).stdout.trim(),
					viaArgv: (yield* shell.execArgv(["pwd"])).stdout.trim(),
				};
			}).pipe(Effect.scoped, Effect.provide(Sandbox.defaultLayer(tmp.path))),
		);

		expect(result.viaExec).toBe(root);
		expect(result.viaArgv).toBe(root);
		expect(result.viaExec).not.toBe(process.cwd());
	});

	it("lets the shell read a file the filesystem wrote at a relative path", async () => {
		await using tmp = await tmpdir();

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const fs = yield* SandboxFileSystem.Service;
				const shell = yield* Shell;
				yield* fs.writeFile("marker.txt", "written via sandbox fs");
				return yield* shell.exec("cat marker.txt");
			}).pipe(Effect.scoped, Effect.provide(Sandbox.defaultLayer(tmp.path))),
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("written via sandbox fs");
	});

	it("resolves an explicit relative command cwd against the sandbox cwd", async () => {
		await using tmp = await tmpdir();
		// macOS resolves /var through a symlink, which `pwd` reports resolved.
		const root = await realpath(tmp.path);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const fs = yield* SandboxFileSystem.Service;
				const shell = yield* Shell;
				yield* fs.mkdir("nested/deep", { recursive: true });
				return yield* shell.execArgv(["pwd"], { cwd: "nested/deep" });
			}).pipe(Effect.scoped, Effect.provide(Sandbox.defaultLayer(tmp.path))),
		);

		expect(result.stdout.trim()).toBe(`${root}/nested/deep`);
	});
});
