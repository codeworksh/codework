import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
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
});
