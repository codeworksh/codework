import { Effect, Layer } from "effect";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { SandboxFileSystem } from "../src/sandbox/fs/filesystem";
import { SandboxFs } from "../src/sandbox/fs/util";
import { Local } from "../src/sandbox/fs/vfs";
import { Sandbox } from "../src/sandbox/sandbox";
import { tmpdir } from "./fixtures/tempdir";

// Derived operations live outside the provider contract precisely so one
// implementation serves every backend. These run the same assertions over an
// in-memory VFS and the real host filesystem.
const run = <A, E, E2>(body: Effect.Effect<A, E, SandboxFileSystem.Service>, backend: Sandbox.LocalBackend<E2>) =>
	Effect.runPromise(body.pipe(Effect.scoped, Effect.provide(Layer.provideMerge(Local.layer, backend))));

describe("SandboxFs.up", () => {
	const tree = (root: string) =>
		Effect.gen(function* () {
			const filesystem = yield* SandboxFileSystem.Service;
			yield* filesystem.mkdir(`${root}/.git`, { recursive: true });
			yield* filesystem.mkdir(`${root}/project/packages/app`, { recursive: true });
			yield* filesystem.writeFile(`${root}/package.json`, "{}");
			yield* filesystem.writeFile(`${root}/project/package.json`, "{}");
			return filesystem;
		});

	it("collects targets nearest-first while walking toward the root", async () => {
		const matches = await run(
			Effect.gen(function* () {
				const filesystem = yield* tree("/workspace");
				return yield* SandboxFs.up(filesystem, {
					targets: [".git", "package.json"],
					start: "/workspace/project/packages/app",
					stop: "/workspace",
				});
			}),
			Sandbox.EnvInMemory.layer(),
		);

		expect(matches).toEqual(["/workspace/project/package.json", "/workspace/.git", "/workspace/package.json"]);
	});

	it("stops at the root when no stop is given", async () => {
		const matches = await run(
			Effect.gen(function* () {
				const filesystem = yield* tree("");
				return yield* SandboxFs.up(filesystem, { targets: [".git"], start: "/project/packages/app" });
			}),
			Sandbox.EnvInMemory.layer(),
		);

		expect(matches).toEqual(["/.git"]);
	});

	it("returns nothing when no target exists", async () => {
		const matches = await run(
			Effect.gen(function* () {
				const filesystem = yield* SandboxFileSystem.Service;
				yield* filesystem.mkdir("/a/b", { recursive: true });
				return yield* SandboxFs.up(filesystem, { targets: ["nope"], start: "/a/b", stop: "/a" });
			}),
			Sandbox.EnvInMemory.layer(),
		);

		expect(matches).toEqual([]);
	});

	// The same code path over real files: a derived operation must not need a
	// per-backend implementation.
	it("behaves identically over the host filesystem", async () => {
		await using tmp = await tmpdir();
		const workspace = path.join(tmp.path, "workspace");
		const start = path.join(workspace, "project", "packages", "app");
		await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
		await fs.mkdir(start, { recursive: true });
		await fs.writeFile(path.join(workspace, "package.json"), "{}");
		await fs.writeFile(path.join(workspace, "project", "package.json"), "{}");

		const matches = await run(
			Effect.gen(function* () {
				const filesystem = yield* SandboxFileSystem.Service;
				return yield* SandboxFs.up(filesystem, { targets: [".git", "package.json"], start, stop: workspace });
			}),
			Sandbox.EnvNodeJSDefault.layer(),
		);

		expect(matches).toEqual([
			path.join(workspace, "project", "package.json"),
			path.join(workspace, ".git"),
			path.join(workspace, "package.json"),
		]);
	});
});

describe("SandboxFs predicates", () => {
	const inMemory = <A, E>(body: Effect.Effect<A, E, SandboxFileSystem.Service>) =>
		run(body, Sandbox.EnvInMemory.layer());

	it("distinguishes files, directories, and absent paths", async () => {
		const result = await inMemory(
			Effect.gen(function* () {
				const filesystem = yield* SandboxFileSystem.Service;
				yield* filesystem.writeFile("/dir/file.txt", "data");

				return {
					dirIsDirectory: yield* SandboxFs.isDirectory(filesystem, "/dir"),
					fileIsDirectory: yield* SandboxFs.isDirectory(filesystem, "/dir/file.txt"),
					missingIsDirectory: yield* SandboxFs.isDirectory(filesystem, "/nope"),
					fileIsFile: yield* SandboxFs.isFile(filesystem, "/dir/file.txt"),
					dirIsFile: yield* SandboxFs.isFile(filesystem, "/dir"),
					missingIsFile: yield* SandboxFs.isFile(filesystem, "/nope"),
				};
			}),
		);

		expect(result).toEqual({
			dirIsDirectory: true,
			fileIsDirectory: false,
			missingIsDirectory: false,
			fileIsFile: true,
			dirIsFile: false,
			missingIsFile: false,
		});
	});

	it("reads a file, or reports undefined when it is missing", async () => {
		const result = await inMemory(
			Effect.gen(function* () {
				const filesystem = yield* SandboxFileSystem.Service;
				yield* filesystem.writeFile("/there.txt", "content");

				return {
					present: yield* SandboxFs.readFileSafe(filesystem, "/there.txt"),
					missing: yield* SandboxFs.readFileSafe(filesystem, "/gone.txt"),
				};
			}),
		);

		expect(result).toEqual({ present: "content", missing: undefined });
	});
});
