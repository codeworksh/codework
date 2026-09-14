import { Effect, Layer } from "effect";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Repo } from "../src/repo/repo.ts";
import type { RepoSchema } from "../src/repo/schema.ts";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import { AbsolutePath } from "../src/schema.ts";
import { Worktree, WorktreeError } from "../src/worktree/worktree.ts";
import { tmpdir } from "./fixtures/tempdir.ts";

const execFilePromise = promisify(execFile);

const runGit = async (cwd: string, ...args: string[]) => (await execFilePromise("git", args, { cwd })).stdout.trim();

const exists = (target: string) =>
	fs
		.stat(target)
		.then(() => true)
		.catch(() => false);

const sandbox = Sandbox.defaultLayer("/");
const layer = Layer.mergeAll(Worktree.layerWith(sandbox), Repo.layerWith(sandbox));

const run = <A>(effect: (worktree: Worktree.Interface, repo: Repo.Interface) => Effect.Effect<A, unknown>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			return yield* effect(yield* Worktree.Service, yield* Repo.Service);
		}).pipe(Effect.provide(layer)),
	);

describe("Worktree", () => {
	let tmp: { path: string; [Symbol.asyncDispose](): Promise<void> };
	let root: string;

	const initRepo = async (label: string) => {
		const dir = path.join(root, `${label}-${randomUUID()}`);
		await fs.mkdir(dir, { recursive: true });
		await runGit(dir, "init", "-b", "main");
		await runGit(dir, "config", "user.name", "Codework Test");
		await runGit(dir, "config", "user.email", "test@codework.sh");
		await fs.writeFile(path.join(dir, "a.txt"), "a\n");
		await runGit(dir, "add", "a.txt");
		await runGit(dir, "commit", "-m", "test: a");
		const repo = await run((_, repos) => repos.find(AbsolutePath.make(dir)));
		if (!repo) throw new Error(`no repo at ${dir}`);
		return repo;
	};

	const fresh = (label: string) => AbsolutePath.make(path.join(root, `${label}-${randomUUID()}`));

	const list = (repo: RepoSchema.Info) => run((worktree) => worktree.list(repo));

	beforeAll(async () => {
		tmp = await tmpdir();
		root = tmp.path;
	});

	afterAll(async () => {
		await tmp?.[Symbol.asyncDispose]();
	});

	it("lists the main checkout first, then linked worktrees, realpath'd", async () => {
		const repo = await initRepo("list");
		// Use a path through the (possibly symlinked) tmp root so realpath matters.
		const linked = path.join(tmp.path, `list-wt-${randomUUID()}`);
		await runGit(repo.directory, "worktree", "add", "--detach", linked, "HEAD");

		expect(await list(repo)).toEqual([
			{ location: repo.directory, main: true },
			{ location: await fs.realpath(linked), main: false },
		]);
	});

	it("add() creates a detached worktree that list() reports", async () => {
		const repo = await initRepo("add");
		const directory = fresh("add-wt");
		expect(await list(repo)).toEqual([{ location: repo.directory, main: true }]);

		await run((worktree) => worktree.add({ repo, directory }));

		expect(await list(repo)).toEqual([
			{ location: repo.directory, main: true },
			{ location: await fs.realpath(directory), main: false },
		]);
		expect(await runGit(directory, "rev-parse", "HEAD")).toBe(await runGit(repo.directory, "rev-parse", "HEAD"));
		await expect(runGit(directory, "symbolic-ref", "--quiet", "HEAD")).rejects.toThrow();
	});

	it("remove() force-removes a dirty worktree and prunes it from list()", async () => {
		const repo = await initRepo("remove");
		const directory = fresh("remove-wt");
		await run((worktree) => worktree.add({ repo, directory }));
		await fs.writeFile(path.join(directory, "dirty.txt"), "uncommitted\n");

		await run((worktree) => worktree.remove({ repo, directory }));

		expect(await exists(directory)).toBe(false);
		expect(await list(repo)).toEqual([{ location: repo.directory, main: true }]);
		expect(await fs.readdir(path.join(repo.store, "worktrees")).catch(() => [])).toEqual([]);
	});

	it("fails with WorktreeError when adding over an occupied path", async () => {
		const repo = await initRepo("add-err");
		const occupied = fresh("occupied");
		await fs.mkdir(occupied, { recursive: true });
		await fs.writeFile(path.join(occupied, "keep.txt"), "keep\n");

		const error = await run((worktree) => worktree.add({ repo, directory: occupied }).pipe(Effect.flip));
		expect(error).toBeInstanceOf(WorktreeError);
		expect((error as WorktreeError).operation).toBe("add");
		expect((error as WorktreeError).directory).toBe(occupied);
		expect((error as WorktreeError).message.length).toBeGreaterThan(0);
	});

	it("fails with WorktreeError when removing a non-worktree path", async () => {
		const repo = await initRepo("remove-err");
		const missing = fresh("missing");

		const error = await run((worktree) => worktree.remove({ repo, directory: missing }).pipe(Effect.flip));
		expect(error).toBeInstanceOf(WorktreeError);
		expect((error as WorktreeError).operation).toBe("remove");
		expect((error as WorktreeError).directory).toBe(missing);
	});
});
