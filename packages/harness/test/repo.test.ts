import { Effect } from "effect";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { type Interface, MARKER, Service, defaultLayer, normalize } from "../src/repo/repo.ts";
import { AbsolutePath } from "../src/schema.ts";
import { Hash } from "../src/util/hash.ts";
import { tmpdir } from "./fixtures/tempdir.ts";

const execFilePromise = promisify(execFile);

const runGit = async (cwd: string, ...args: string[]) => (await execFilePromise("git", args, { cwd })).stdout.trim();

const exists = (target: string) =>
	fs
		.stat(target)
		.then(() => true)
		.catch(() => false);

const withRepo = <A>(effect: (repo: Interface) => Effect.Effect<A, unknown>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			return yield* effect(yield* Service);
		}).pipe(Effect.provide(defaultLayer("/"))),
	);

const find = (directory: string) => withRepo((repo) => repo.find(AbsolutePath.make(directory)));

describe("Repo", () => {
	let tmp: { path: string; [Symbol.asyncDispose](): Promise<void> };
	let root: string;

	const initRepo = async (label: string, commit = true) => {
		const dir = path.join(root, `${label}-${randomUUID()}`);
		await fs.mkdir(dir, { recursive: true });
		await runGit(dir, "init", "-b", "main");
		await runGit(dir, "config", "user.name", "Codework Test");
		await runGit(dir, "config", "user.email", "test@codework.sh");
		if (commit) {
			await fs.writeFile(path.join(dir, "a.txt"), "a\n");
			await runGit(dir, "add", "a.txt");
			await runGit(dir, "commit", "-m", "test: a");
		}
		return fs.realpath(dir);
	};

	beforeAll(async () => {
		tmp = await tmpdir();
		root = tmp.path;
	});

	afterAll(async () => {
		await tmp?.[Symbol.asyncDispose]();
	});

	describe("find", () => {
		it("resolves a normal clone: directory owns both gitDir and store", async () => {
			const dir = await initRepo("find-plain");
			expect(await find(dir)).toEqual({
				directory: dir,
				gitDir: path.join(dir, ".git"),
				store: path.join(dir, ".git"),
			});
		});

		it("returns the toplevel from a nested subdirectory", async () => {
			const dir = await initRepo("find-nested");
			const nested = path.join(dir, "packages", "x");
			await fs.mkdir(nested, { recursive: true });
			expect((await find(nested))?.directory).toBe(dir);
		});

		it("maps a linked worktree to its own gitDir and the shared store", async () => {
			const dir = await initRepo("find-linked");
			const linked = path.join(root, `find-linked-wt-${randomUUID()}`);
			await runGit(dir, "worktree", "add", "--detach", linked, "HEAD");
			const realLinked = await fs.realpath(linked);

			expect(await find(realLinked)).toEqual({
				directory: realLinked,
				gitDir: path.join(dir, ".git", "worktrees", path.basename(linked)),
				store: path.join(dir, ".git"),
			});
		});

		it("returns undefined outside any repository", async () => {
			const outside = path.join(root, `not-a-repo-${randomUUID()}`);
			await fs.mkdir(outside, { recursive: true });
			expect(await find(outside)).toBeUndefined();
		});

		it("returns undefined for a bare repository", async () => {
			const bare = path.join(root, `bare-${randomUUID()}`);
			// `.git` as a directory holding a bare repo: walk-up finds it, rev-parse has no toplevel.
			await fs.mkdir(bare, { recursive: true });
			await runGit(bare, "init", "--bare", ".git");
			expect(await find(bare)).toBeUndefined();
		});

		it("returns the realpath of a symlinked checkout", async () => {
			const dir = await initRepo("find-symlink");
			const alias = path.join(root, `alias-${randomUUID()}`);
			await fs.symlink(dir, alias);
			expect((await find(alias))?.directory).toBe(dir);
		});
	});

	describe("identity", () => {
		const identityOf = async (dir: string) => {
			const repo = await find(dir);
			if (!repo) throw new Error(`no repo at ${dir}`);
			return { repo, identity: await withRepo((service) => service.identity(repo)) };
		};

		it("hashes the normalized origin url and stamps the marker", async () => {
			const dir = await initRepo("id-remote");
			await runGit(dir, "remote", "add", "origin", "git@github.com:Org/Repo.git");

			const { repo, identity } = await identityOf(dir);
			expect(identity).toEqual({ id: Hash.fast("git:github.com/org/repo"), name: "repo", stamp: true });
			expect(await fs.readFile(path.join(repo.store, MARKER), "utf8")).toBe(identity.id);

			// second call: marker wins, nothing is re-stamped
			expect(await withRepo((service) => service.identity(repo))).toEqual({ ...identity, stamp: false });
		});

		it("falls back to the root commit without an origin", async () => {
			const dir = await initRepo("id-root");
			const rootCommit = await runGit(dir, "rev-list", "--max-parents=0", "HEAD");

			const { repo, identity } = await identityOf(dir);
			expect(identity).toEqual({ id: rootCommit, name: path.basename(dir), stamp: true });
			expect(await fs.readFile(path.join(repo.store, MARKER), "utf8")).toBe(rootCommit);
		});

		it("yields no id and writes no marker on an unborn HEAD without origin", async () => {
			const dir = await initRepo("id-unborn", false);
			const { repo, identity } = await identityOf(dir);
			expect(identity).toEqual({ id: undefined, name: path.basename(dir), stamp: false });
			expect(await exists(path.join(repo.store, MARKER))).toBe(false);
		});

		it("prefers an existing marker over the origin", async () => {
			const dir = await initRepo("id-marker");
			await runGit(dir, "remote", "add", "origin", "https://github.com/org/repo");
			await fs.writeFile(path.join(dir, ".git", MARKER), "pinned-id\n");

			const { identity } = await identityOf(dir);
			expect(identity).toEqual({ id: "pinned-id", name: "repo", stamp: false });
			expect(await fs.readFile(path.join(dir, ".git", MARKER), "utf8")).toBe("pinned-id\n");
		});
	});

	describe("normalize", () => {
		it.each([
			"git@github.com:Org/Repo.git",
			"https://github.com/org/repo",
			"ssh://git@github.com/org/repo/",
			"https://GitHub.com/Org/Repo.git/",
		])("canonicalises %s", (url) => {
			expect(normalize(url)).toBe("github.com/org/repo");
		});

		it("rejects file urls and empty input", () => {
			expect(normalize("file:///x")).toBeUndefined();
			expect(normalize("")).toBeUndefined();
			expect(normalize("   ")).toBeUndefined();
		});
	});
});
