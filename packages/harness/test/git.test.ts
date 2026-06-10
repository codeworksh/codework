import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { AppProcessError, type Interface, Service, WorktreeError, defaultLayer } from "../src/git";
import { AbsolutePath } from "../src/schema";
import { tmpdir } from "./fixtures/tempdir";

const execFilePromise = promisify(execFile);

/**
 * The real upstream repository. It is cloned exactly once (in `beforeAll`) to
 * exercise `git.clone` against the network; every other test derives cheap
 * local bare remotes and clones from the resulting `seed` working tree so the
 * suite stays fast and deterministic.
 */
const remote = "https://github.com/codeworksh/69th";

const runGit = async (cwd: string, ...args: string[]) => {
	const result = await execFilePromise("git", args, { cwd });
	return result.stdout.trim();
};

const configureDeveloper = async (directory: string) => {
	await runGit(directory, "config", "user.name", "Codework Test");
	await runGit(directory, "config", "user.email", "test@codework.sh");
};

const commitFile = async (directory: string, name: string, contents: string, message: string) => {
	await fs.writeFile(path.join(directory, name), contents);
	await runGit(directory, "add", name);
	await runGit(directory, "commit", "-m", message);
	return runGit(directory, "rev-parse", "HEAD");
};

const exists = async (target: string) =>
	fs
		.stat(target)
		.then(() => true)
		.catch(() => false);

const withGit = <A>(effect: (git: Interface) => Effect.Effect<A, unknown>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			return yield* effect(yield* Service);
		}).pipe(Effect.provide(defaultLayer("/"))),
	);

/**
 * Build a `Repo` value without going through `git.find`. Only `directory` is
 * consulted by `remote`/`roots`, so a synthetic `store` is good enough for
 * those call sites.
 */
const repoAt = (directory: string): { directory: AbsolutePath; store: AbsolutePath } => ({
	directory: AbsolutePath.make(directory),
	store: AbsolutePath.make(path.join(directory, ".git")),
});

describe("Git", () => {
	let tmp: { path: string; [Symbol.asyncDispose](): Promise<void> };
	let root: string;
	// Real network clone of `remote`, seeded with extra history below.
	let seed: string;
	let seedMainHead: string;
	let seedFirstHead: string;
	// Local bare remote derived from `seed`; the shared, read-only origin for
	// the fast tests.
	let bareRemote: string;
	let cloneResult: { exitCode: number; text: string; stderr: string };

	const isolatedRemote = async (label: string) => {
		const bare = path.join(root, `${label}-${randomUUID()}.git`);
		await runGit(root, "clone", "--bare", seed, bare);
		return bare;
	};

	const cloneOf = async (origin: string, label: string) => {
		const dir = path.join(root, `${label}-${randomUUID()}`);
		await runGit(root, "clone", origin, dir);
		await configureDeveloper(dir);
		return dir;
	};

	const initRepo = async (label: string) => {
		const dir = path.join(root, `${label}-${randomUUID()}`);
		await fs.mkdir(dir, { recursive: true });
		await runGit(dir, "init", "-b", "main");
		await configureDeveloper(dir);
		return dir;
	};

	beforeAll(async () => {
		tmp = await tmpdir();
		root = tmp.path;
		seed = path.join(root, "seed");

		// (1) Real clone over the network — this is the `git.clone` smoke test
		// reused as setup, so we only hit the network once.
		cloneResult = await withGit((git) => git.clone({ remote, target: seed, branch: "main", depth: 100 }));
		await configureDeveloper(seed);

		// (2) Grow some history so depth-limited clones are observably different.
		seedFirstHead = await runGit(seed, "rev-parse", "HEAD");
		await commitFile(seed, "seed-1.txt", "one\n", "test: seed commit 1");
		seedMainHead = await commitFile(seed, "seed-2.txt", "two\n", "test: seed commit 2");

		// (3) A second branch so `--branch` clones have something to land on.
		await runGit(seed, "switch", "-c", "feature");
		await commitFile(seed, "feature.txt", "feature\n", "test: feature commit");
		await runGit(seed, "switch", "main");

		// (4) The shared, read-only bare remote used by the fast tests.
		bareRemote = path.join(root, "origin.git");
		await runGit(root, "clone", "--bare", seed, bareRemote);
	}, 180_000);

	afterAll(async () => {
		await tmp?.[Symbol.asyncDispose]();
	});

	describe("clone", () => {
		it("clones the real remote with a successful result", () => {
			expect(cloneResult.exitCode, cloneResult.stderr).toBe(0);
			expect(seedFirstHead).toMatch(/^[0-9a-f]{40}$/);
		});

		it("checks out a requested branch", async () => {
			const target = path.join(root, `clone-branch-${randomUUID()}`);
			const result = await withGit((git) =>
				git.clone({ remote: bareRemote, target, branch: "feature", depth: 100 }),
			);
			expect(result.exitCode, result.stderr).toBe(0);
			expect(await withGit((git) => git.branch(target))).toBe("feature");
			expect(await exists(path.join(target, "feature.txt"))).toBe(true);
		});

		it("honours an explicit shallow depth", async () => {
			const shallow = path.join(root, `clone-shallow-${randomUUID()}`);
			const deep = path.join(root, `clone-deep-${randomUUID()}`);
			// `git` only honours `--depth` over a transport, not for a plain
			// local path clone, so address the bare remote via `file://`.
			const fileRemote = `file://${bareRemote}`;

			const shallowResult = await withGit((git) =>
				git.clone({ remote: fileRemote, target: shallow, branch: "main", depth: 1 }),
			);
			const deepResult = await withGit((git) =>
				git.clone({ remote: fileRemote, target: deep, branch: "main", depth: 100 }),
			);

			expect(shallowResult.exitCode, shallowResult.stderr).toBe(0);
			expect(deepResult.exitCode, deepResult.stderr).toBe(0);
			expect(await runGit(shallow, "rev-list", "--count", "HEAD")).toBe("1");
			expect(Number(await runGit(deep, "rev-list", "--count", "HEAD"))).toBeGreaterThan(1);
		});

		it("returns a failing result for an unreachable remote", async () => {
			const target = path.join(root, `clone-missing-${randomUUID()}`);
			const result = await withGit((git) =>
				git.clone({ remote: path.join(root, "does-not-exist.git"), target, depth: 1 }),
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr.length).toBeGreaterThan(0);
			expect(await exists(target)).toBe(false);
		});
	});

	describe("find", () => {
		it("discovers the repository from a nested subdirectory", async () => {
			const dir = await cloneOf(bareRemote, "find-nested");
			const realDir = await fs.realpath(dir);
			const nested = path.join(dir, "packages");

			const discovered = await withGit((git) => git.find(AbsolutePath.make(nested)));
			expect(discovered).toEqual({
				directory: realDir,
				store: path.join(realDir, ".git"),
			});
		});

		it("returns undefined outside of any working tree", async () => {
			const outside = path.join(root, `not-a-repo-${randomUUID()}`);
			await fs.mkdir(outside, { recursive: true });
			expect(await withGit((git) => git.find(AbsolutePath.make(outside)))).toBeUndefined();
		});

		it("maps a linked worktree back to the shared store", async () => {
			const dir = await cloneOf(bareRemote, "find-worktree");
			const realDir = await fs.realpath(dir);
			const repo = repoAt(realDir);
			const worktreeDirectory = AbsolutePath.make(path.join(root, `find-wt-${randomUUID()}`));

			await withGit((git) => git.worktreeCreate({ repo, directory: worktreeDirectory }));
			const realWorktree = await fs.realpath(worktreeDirectory);

			const discovered = await withGit((git) => git.find(worktreeDirectory));
			expect(discovered).toEqual({
				directory: AbsolutePath.make(realWorktree),
				store: AbsolutePath.make(path.join(realDir, ".git")),
			});
		});
	});

	describe("introspection", () => {
		it("reads the configured remote url, including a missing one", async () => {
			const dir = await cloneOf(bareRemote, "remote");
			const repo = repoAt(dir);
			expect(await withGit((git) => git.remote(repo))).toBe(bareRemote);
			expect(await withGit((git) => git.remote(repo, "origin"))).toBe(bareRemote);
			expect(await withGit((git) => git.remote(repo, "upstream"))).toBeUndefined();
		});

		it("reads remote.origin.url and reports its absence", async () => {
			const cloned = await cloneOf(bareRemote, "origin-present");
			expect(await withGit((git) => git.origin(cloned))).toBe(bareRemote);

			const bare = await initRepo("origin-absent");
			await commitFile(bare, "a.txt", "a\n", "test: a");
			expect(await withGit((git) => git.origin(bare))).toBeUndefined();
		});

		it("returns the single root commit, sorted", async () => {
			const dir = await cloneOf(bareRemote, "roots-single");
			const roots = await withGit((git) => git.roots(repoAt(dir)));
			expect(roots).toHaveLength(1);
			expect(roots[0]).toMatch(/^[0-9a-f]{40}$/);
		});

		it("returns multiple roots for unrelated histories, sorted", async () => {
			const dir = await initRepo("roots-multi");
			await commitFile(dir, "a.txt", "a\n", "test: a");
			await runGit(dir, "checkout", "--orphan", "second");
			await runGit(dir, "rm", "-f", "a.txt");
			await commitFile(dir, "b.txt", "b\n", "test: b");
			await runGit(dir, "checkout", "main");
			await runGit(dir, "merge", "--allow-unrelated-histories", "-m", "merge", "second");

			const roots = await withGit((git) => git.roots(repoAt(dir)));
			expect(roots).toHaveLength(2);
			expect(roots.every((sha) => /^[0-9a-f]{40}$/.test(sha))).toBe(true);
			expect(roots).toEqual([...roots].sort());
		});

		it("reads HEAD, returning undefined outside a repository", async () => {
			const dir = await cloneOf(bareRemote, "head");
			expect(await withGit((git) => git.head(dir))).toBe(seedMainHead);

			const outside = path.join(root, `head-outside-${randomUUID()}`);
			await fs.mkdir(outside, { recursive: true });
			expect(await withGit((git) => git.head(outside))).toBeUndefined();
		});

		it("resolves the git directory for a clone and a worktree", async () => {
			const dir = await cloneOf(bareRemote, "dir");
			const realDir = await fs.realpath(dir);
			// `--git-dir` comes back relative (`.git`); `git.dir` resolves it
			// against the path it was handed, not the canonical realpath.
			expect(await withGit((git) => git.dir(dir))).toBe(path.join(dir, ".git"));

			const worktreeDirectory = AbsolutePath.make(path.join(root, `dir-wt-${randomUUID()}`));
			await withGit((git) => git.worktreeCreate({ repo: repoAt(realDir), directory: worktreeDirectory }));
			const gitDir = await withGit((git) => git.dir(worktreeDirectory));
			expect(gitDir).toBe(path.join(realDir, ".git", "worktrees", path.basename(worktreeDirectory)));
		});

		it("reports the current branch and undefined when detached", async () => {
			const dir = await cloneOf(bareRemote, "branch");
			expect(await withGit((git) => git.branch(dir))).toBe("main");

			await runGit(dir, "checkout", "--detach", "HEAD");
			expect(await withGit((git) => git.branch(dir))).toBeUndefined();
		});

		it("reads the remote HEAD symbolic ref, stripping the refs/remotes prefix", async () => {
			// A clone records `refs/remotes/origin/HEAD` from the remote's HEAD.
			const dir = await cloneOf(bareRemote, "remote-head");
			expect(await withGit((git) => git.remoteHead(dir))).toBe("origin/main");

			// A repo without that ref (no origin remote) reports undefined.
			const local = await initRepo("remote-head-absent");
			await commitFile(local, "a.txt", "a\n", "test: a");
			expect(await withGit((git) => git.remoteHead(local))).toBeUndefined();
		});
	});

	describe("synchronisation", () => {
		it("fetches all remotes and prunes", async () => {
			const bare = await isolatedRemote("fetch");
			const consumer = await cloneOf(bare, "fetch-consumer");
			const publisher = await cloneOf(bare, "fetch-publisher");

			const published = await commitFile(publisher, "main-update.txt", "update\n", "test: update main");
			await runGit(publisher, "push", "origin", "main");

			const result = await withGit((git) => git.fetch(consumer));
			expect(result.exitCode, result.stderr).toBe(0);
			expect(await runGit(consumer, "rev-parse", "origin/main")).toBe(published);
		});

		it("fetches a single branch into origin/<branch>", async () => {
			const bare = await isolatedRemote("fetch-branch");
			const consumer = await cloneOf(bare, "fetch-branch-consumer");
			const publisher = await cloneOf(bare, "fetch-branch-publisher");
			const branchName = `topic-${randomUUID()}`;

			await runGit(publisher, "switch", "-c", branchName);
			const published = await commitFile(publisher, "topic.txt", "topic\n", "test: topic");
			await runGit(publisher, "push", "-u", "origin", branchName);

			const result = await withGit((git) => git.fetchBranch(consumer, branchName));
			expect(result.exitCode, result.stderr).toBe(0);
			expect(await runGit(consumer, "rev-parse", `origin/${branchName}`)).toBe(published);
		});

		it("checks out a remote-tracking branch with -B", async () => {
			const bare = await isolatedRemote("checkout");
			const consumer = await cloneOf(bare, "checkout-consumer");
			const publisher = await cloneOf(bare, "checkout-publisher");
			const branchName = `release-${randomUUID()}`;

			await runGit(publisher, "switch", "-c", branchName);
			const published = await commitFile(publisher, "release.txt", "release\n", "test: release");
			await runGit(publisher, "push", "-u", "origin", branchName);
			await withGit((git) => git.fetchBranch(consumer, branchName));

			const result = await withGit((git) => git.checkout(consumer, branchName));
			expect(result.exitCode, result.stderr).toBe(0);
			expect(await withGit((git) => git.branch(consumer))).toBe(branchName);
			expect(await withGit((git) => git.head(consumer))).toBe(published);
			expect(await fs.readFile(path.join(consumer, "release.txt"), "utf8")).toBe("release\n");
		});

		it("hard-resets the working tree to a target", async () => {
			const dir = await cloneOf(bareRemote, "reset");
			const base = await withGit((git) => git.head(dir));
			const moved = await commitFile(dir, "scratch.txt", "scratch\n", "test: scratch");
			expect(moved).not.toBe(base);
			expect(await withGit((git) => git.head(dir))).toBe(moved);

			const result = await withGit((git) => git.reset(dir, base!));
			expect(result.exitCode, result.stderr).toBe(0);
			expect(await withGit((git) => git.head(dir))).toBe(base);
			expect(await exists(path.join(dir, "scratch.txt"))).toBe(false);
		});
	});

	describe("worktrees", () => {
		it("creates a detached worktree and lists it", async () => {
			const dir = await cloneOf(bareRemote, "wt-create");
			const realDir = await fs.realpath(dir);
			const repo = repoAt(realDir);
			const worktreeDirectory = AbsolutePath.make(path.join(root, `wt-${randomUUID()}`));

			expect(await withGit((git) => git.worktreeList(repo))).toEqual([AbsolutePath.make(realDir)]);

			await withGit((git) => git.worktreeCreate({ repo, directory: worktreeDirectory }));
			const realWorktree = AbsolutePath.make(await fs.realpath(worktreeDirectory));

			expect(await withGit((git) => git.worktreeList(repo))).toEqual([AbsolutePath.make(realDir), realWorktree]);
			// `--detach` leaves the worktree on a detached HEAD at the repo HEAD.
			expect(await withGit((git) => git.branch(worktreeDirectory))).toBeUndefined();
			expect(await withGit((git) => git.head(worktreeDirectory))).toBe(await withGit((git) => git.head(dir)));
		});

		it("force-removes a worktree even when it is dirty", async () => {
			const dir = await cloneOf(bareRemote, "wt-remove");
			const realDir = await fs.realpath(dir);
			const repo = repoAt(realDir);
			const worktreeDirectory = AbsolutePath.make(path.join(root, `wt-rm-${randomUUID()}`));

			await withGit((git) => git.worktreeCreate({ repo, directory: worktreeDirectory }));
			await fs.writeFile(path.join(worktreeDirectory, "dirty.txt"), "uncommitted\n");

			await withGit((git) => git.worktreeRemove({ repo, directory: worktreeDirectory }));
			expect(await exists(worktreeDirectory)).toBe(false);
			expect(await withGit((git) => git.worktreeList(repo))).toEqual([AbsolutePath.make(realDir)]);
		});

		it("fails with a WorktreeError when creating over an existing path", async () => {
			const dir = await cloneOf(bareRemote, "wt-create-err");
			const repo = repoAt(await fs.realpath(dir));
			const occupied = AbsolutePath.make(path.join(root, `wt-occupied-${randomUUID()}`));
			await fs.mkdir(occupied, { recursive: true });
			await fs.writeFile(path.join(occupied, "keep.txt"), "keep\n");

			const error = await withGit((git) => git.worktreeCreate({ repo, directory: occupied }).pipe(Effect.flip));
			expect(error).toBeInstanceOf(WorktreeError);
			expect((error as WorktreeError).operation).toBe("create");
			expect((error as WorktreeError).directory).toBe(occupied);
			expect((error as WorktreeError).message.length).toBeGreaterThan(0);
		});

		it("fails with a WorktreeError when removing a non-worktree path", async () => {
			const dir = await cloneOf(bareRemote, "wt-remove-err");
			const repo = repoAt(await fs.realpath(dir));
			const missing = AbsolutePath.make(path.join(root, `wt-missing-${randomUUID()}`));

			const error = await withGit((git) => git.worktreeRemove({ repo, directory: missing }).pipe(Effect.flip));
			expect(error).toBeInstanceOf(WorktreeError);
			expect((error as WorktreeError).operation).toBe("remove");
			expect((error as WorktreeError).directory).toBe(missing);
		});
	});

	describe("errors", () => {
		it("exposes a tagged AppProcessError type", () => {
			const error = new AppProcessError({ command: "git status" });
			expect(error).toBeInstanceOf(AppProcessError);
			expect(error._tag).toBe("AppProcessError");
			expect(error.command).toBe("git status");
		});

		it("tags WorktreeError under the Git namespace", () => {
			const error = new WorktreeError({ operation: "list", message: "boom" });
			expect(error._tag).toBe("Git.WorktreeError");
			expect(error.operation).toBe("list");
		});
	});
});
