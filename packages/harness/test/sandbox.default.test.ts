import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Service, Vfs } from "../src/filesystem/filesystem";
import { Sandbox } from "../src/sandbox/sandbox";
import { tmpdir } from "./fixtures/tempdir";

describe("Sandbox.EnvDefault", () => {
	it("should resolve relative file operations against cwd", async () => {
		await using tmp = await tmpdir();

		await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* Service;

				yield* filesystem.writeFileString("src/index.ts", "export const value = 1;\n");

				expect(yield* filesystem.readFileString("src/index.ts")).toBe("export const value = 1;\n");
				expect(yield* filesystem.readFileString(path.join(tmp.path, "src", "index.ts"))).toBe(
					"export const value = 1;\n",
				);
				expect(yield* filesystem.exists("src/index.ts")).toBe(true);
				expect(yield* filesystem.isDir("src")).toBe(true);
			}).pipe(Effect.provide(Sandbox.services(Sandbox.EnvDefault.layer({ cwd: tmp.path })))),
		);

		expect(await fs.readFile(path.join(tmp.path, "src", "index.ts"), "utf8")).toBe("export const value = 1;\n");
	});

	it("should see files created by the host under cwd", async () => {
		await using tmp = await tmpdir();
		await fs.writeFile(path.join(tmp.path, "host.txt"), "from host");

		const content = await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* Service;
				return yield* filesystem.readFileString("host.txt");
			}).pipe(Effect.provide(Sandbox.services(Sandbox.EnvDefault.layer({ cwd: tmp.path })))),
		);

		expect(content).toBe("from host");
	});

	it("should keep absolute file operations rooted at the host filesystem", async () => {
		await using tmp = await tmpdir();
		const cwd = path.join(tmp.path, "cwd");
		const absoluteFile = path.join(tmp.path, "absolute.txt");
		await fs.mkdir(cwd);

		await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* Service;

				yield* filesystem.writeFileString(absoluteFile, "absolute");

				expect(yield* filesystem.readFileString(absoluteFile)).toBe("absolute");
				expect(yield* filesystem.exists("absolute.txt")).toBe(false);
			}).pipe(Effect.provide(Sandbox.services(Sandbox.EnvDefault.layer({ cwd })))),
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

		const content = await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* Service;
				yield* filesystem.writeFileString("leak.txt", "changed");
				return yield* filesystem.readFileString("leak.txt");
			}).pipe(Effect.provide(Sandbox.services(Sandbox.EnvDefault.layer({ cwd })))),
		);

		expect(content).toBe("changed");
		expect(await fs.readFile(outside, "utf8")).toBe("changed");
	});

	it("should preserve host symlink semantics through the VFS", async () => {
		await using tmp = await tmpdir();

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const vfs = yield* Vfs;
				yield* Effect.promise(async () => {
					await vfs.promises.writeFile("target.txt", "inside");
					await vfs.promises.symlink("target.txt", "link.txt");
				});

				return {
					content: yield* Effect.promise(() => vfs.promises.readFile("link.txt", "utf8")),
					target: yield* Effect.promise(() => vfs.promises.readlink("link.txt")),
				};
			}).pipe(Effect.provide(Sandbox.EnvDefault.layer({ cwd: tmp.path }))),
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
				const filesystem = yield* Service;
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

				yield* filesystem.writeFileString(marker, "sandbox-data");

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
});
