import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { type Interface, Service, defaultLayer } from "../src/git";
import { AbsolutePath } from "../src/schema";
import { tmpdir } from "./fixtures/tempdir";

const execFilePromise = promisify(execFile);
const remote = "https://github.com/codeworksh/69th";

const runGit = async (cwd: string, ...args: string[]) => {
	const result = await execFilePromise("git", args, { cwd });
	return result.stdout.trim();
};

const commitFile = async (directory: string, name: string, contents: string, message: string) => {
	await fs.writeFile(path.join(directory, name), contents);
	await runGit(directory, "add", name);
	await runGit(directory, "commit", "-m", message);
	return runGit(directory, "rev-parse", "HEAD");
};

const configureDeveloper = async (directory: string) => {
	await runGit(directory, "config", "user.name", "Codework Test");
	await runGit(directory, "config", "user.email", "test@codework.sh");
};

const withGit = <A>(effect: (git: Interface) => Effect.Effect<A, unknown>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			return yield* effect(yield* Service);
		}).pipe(Effect.provide(defaultLayer("/"))),
	);

describe("Git", () => {
	it("supports a complete developer workflow against a real repository", async () => {
		await using tmp = await tmpdir();
		const cloneDirectory = path.join(tmp.path, "69th");
		const bareRemote = path.join(tmp.path, "origin.git");
		const publisherDirectory = path.join(tmp.path, "publisher");
		const worktreeDirectory = AbsolutePath.make(path.join(tmp.path, "worktree"));
		const branchName = `test-${randomUUID()}`;
		const testFile = `git-test-${randomUUID()}.txt`;

		const clone = await withGit((git) =>
			git.clone({
				remote,
				target: cloneDirectory,
				branch: "main",
				depth: 100,
			}),
		);
		expect(clone.exitCode, clone.stderr).toBe(0);

		const realCloneDirectory = await fs.realpath(cloneDirectory);
		const nestedDirectory = path.join(cloneDirectory, "packages");
		const discovered = await withGit((git) => git.find(AbsolutePath.make(nestedDirectory)));
		expect(discovered).toEqual({
			directory: realCloneDirectory,
			store: path.join(realCloneDirectory, ".git"),
		});
		if (!discovered) throw new Error("Expected the cloned repository to be discovered");

		const initial = await withGit((git) =>
			Effect.gen(function* () {
				return {
					remote: yield* git.remote(discovered),
					missingRemote: yield* git.remote(discovered, "missing"),
					origin: yield* git.origin(cloneDirectory),
					roots: yield* git.roots(discovered),
					head: yield* git.head(cloneDirectory),
					dir: yield* git.dir(cloneDirectory),
					branch: yield* git.branch(cloneDirectory),
					remoteHead: yield* git.remoteHead(cloneDirectory),
				};
			}),
		);

		expect(initial.remote).toBe(remote);
		expect(initial.missingRemote).toBeUndefined();
		expect(initial.origin).toBe(remote);
		expect(initial.roots).toHaveLength(1);
		expect(initial.roots[0]).toMatch(/^[0-9a-f]{40}$/);
		expect(initial.head).toMatch(/^[0-9a-f]{40}$/);
		expect(initial.dir).toBe(path.join(cloneDirectory, ".git"));
		expect(initial.branch).toBe("main");
		expect(initial.remoteHead).toBeUndefined();

		await runGit(cloneDirectory, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
		expect(await withGit((git) => git.remoteHead(cloneDirectory))).toBe("origin/main");

		await runGit(tmp.path, "clone", "--bare", cloneDirectory, bareRemote);
		await runGit(cloneDirectory, "remote", "set-url", "origin", bareRemote);
		await runGit(tmp.path, "clone", bareRemote, publisherDirectory);
		await configureDeveloper(publisherDirectory);
		const publishedMainHead = await commitFile(
			publisherDirectory,
			`fetch-${testFile}`,
			`fetched main ${branchName}\n`,
			`test: update main for ${branchName}`,
		);
		await runGit(publisherDirectory, "push", "origin", "main");

		const fetch = await withGit((git) => git.fetch(cloneDirectory));
		expect(fetch.exitCode, fetch.stderr).toBe(0);
		expect(await runGit(cloneDirectory, "rev-parse", "origin/main")).toBe(publishedMainHead);

		await runGit(publisherDirectory, "switch", "-c", branchName);
		const publishedHead = await commitFile(
			publisherDirectory,
			testFile,
			`published ${branchName}\n`,
			`test: publish ${branchName}`,
		);
		await runGit(publisherDirectory, "push", "-u", "origin", branchName);

		const fetchBranch = await withGit((git) => git.fetchBranch(cloneDirectory, branchName));
		expect(fetchBranch.exitCode, fetchBranch.stderr).toBe(0);
		expect(await runGit(cloneDirectory, "rev-parse", `origin/${branchName}`)).toBe(publishedHead);

		const checkout = await withGit((git) => git.checkout(cloneDirectory, branchName));
		expect(checkout.exitCode, checkout.stderr).toBe(0);
		expect(await withGit((git) => git.branch(cloneDirectory))).toBe(branchName);
		expect(await fs.readFile(path.join(cloneDirectory, testFile), "utf8")).toBe(`published ${branchName}\n`);

		await configureDeveloper(cloneDirectory);
		const localHead = await commitFile(
			cloneDirectory,
			testFile,
			`local ${branchName}\n`,
			`test: local ${branchName}`,
		);
		expect(localHead).not.toBe(publishedHead);
		expect(await withGit((git) => git.head(cloneDirectory))).toBe(localHead);

		const reset = await withGit((git) => git.reset(cloneDirectory, publishedHead));
		expect(reset.exitCode, reset.stderr).toBe(0);
		expect(await withGit((git) => git.head(cloneDirectory))).toBe(publishedHead);
		expect(await fs.readFile(path.join(cloneDirectory, testFile), "utf8")).toBe(`published ${branchName}\n`);

		await withGit((git) => git.worktreeCreate({ repo: discovered, directory: worktreeDirectory }));
		const realWorktreeDirectory = AbsolutePath.make(await fs.realpath(worktreeDirectory));
		const worktrees = await withGit((git) => git.worktreeList(discovered));
		expect(worktrees).toEqual([AbsolutePath.make(realCloneDirectory), realWorktreeDirectory]);
		expect(await withGit((git) => git.branch(worktreeDirectory))).toBeUndefined();
		expect(await withGit((git) => git.head(worktreeDirectory))).toBe(publishedHead);

		const worktreeRepo = await withGit((git) => git.find(worktreeDirectory));
		expect(worktreeRepo).toEqual({
			directory: realWorktreeDirectory,
			store: discovered.store,
		});

		await fs.writeFile(path.join(worktreeDirectory, testFile), "dirty worktree\n");
		await withGit((git) => git.worktreeRemove({ repo: discovered, directory: worktreeDirectory }));
		expect(await fs.stat(worktreeDirectory).catch(() => undefined)).toBeUndefined();
		expect(await withGit((git) => git.worktreeList(discovered))).toEqual([AbsolutePath.make(realCloneDirectory)]);
	}, 120_000);
});
