import { Context, Effect, Layer, Schema } from "effect";
import { posix as path } from "../posix.ts";
import { SandboxFs } from "../sandbox/fs/util.ts";
import { SandboxIO } from "../sandbox/io.ts";
import { Sandbox } from "../sandbox/sandbox.ts";
import { AbsolutePath } from "../schema.ts";

// TODO: shouldn't it be called GitError or something
export class AppProcessError extends Schema.TaggedError<AppProcessError>()("AppProcessError", {
	command: Schema.String,
	exitCode: Schema.optional(Schema.Finite),
	stderr: Schema.optional(Schema.String),
	cause: Schema.optional(Schema.Defect()),
}) {}

export interface Repo {
	/**
	 * The root directory of the working tree that contains the input path.
	 *
	 * For `/home/me/app/src/file.ts` in a normal clone, this is `/home/me/app`.
	 * For `/home/me/app-feature/src/file.ts` in a linked worktree, this is
	 * `/home/me/app-feature`.
	 */
	readonly directory: AbsolutePath;
	/**
	 * The shared Git storage directory used by this repo and any linked worktrees.
	 *
	 * For a normal clone at `/home/me/app`, this is usually `/home/me/app/.git`.
	 * For a linked worktree at `/home/me/app-feature` whose main checkout is
	 * `/home/me/app`, this is usually `/home/me/app/.git`.
	 */
	readonly store: AbsolutePath;
}

export interface Result {
	readonly exitCode: number;
	readonly text: string;
	readonly stderr: string;
}

export class WorktreeError extends Schema.TaggedError<WorktreeError>()("Git.WorktreeError", {
	operation: Schema.Literals(["create", "remove", "list"]),
	message: Schema.String,
	directory: Schema.optional(AbsolutePath),
	cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
	readonly find: (input: AbsolutePath) => Effect.Effect<Repo | undefined>;
	readonly remote: (repo: Repo, name?: string) => Effect.Effect<string | undefined>;
	readonly roots: (repo: Repo) => Effect.Effect<string[]>;
	readonly origin: (directory: string) => Effect.Effect<string | undefined>;
	readonly head: (directory: string) => Effect.Effect<string | undefined>;
	readonly dir: (directory: string) => Effect.Effect<string | undefined>;
	readonly branch: (directory: string) => Effect.Effect<string | undefined>;
	readonly remoteHead: (directory: string) => Effect.Effect<string | undefined>;
	readonly clone: (input: {
		remote: string;
		target: string;
		branch?: string;
		depth?: number;
	}) => Effect.Effect<Result, AppProcessError>;
	readonly fetch: (directory: string) => Effect.Effect<Result, AppProcessError>;
	readonly fetchBranch: (directory: string, branch: string) => Effect.Effect<Result, AppProcessError>;
	readonly checkout: (directory: string, branch: string) => Effect.Effect<Result, AppProcessError>;
	readonly reset: (directory: string, target: string) => Effect.Effect<Result, AppProcessError>;
	readonly push: (input: {
		readonly directory: string;
		readonly refspec: string;
		readonly remote?: string;
		readonly env?: Record<string, string>;
	}) => Effect.Effect<Result, AppProcessError>;
	readonly worktreeCreate: (input: { repo: Repo; directory: AbsolutePath }) => Effect.Effect<void, WorktreeError>;
	readonly worktreeRemove: (input: { repo: Repo; directory: AbsolutePath }) => Effect.Effect<void, WorktreeError>;
	readonly worktreeList: (repo: Repo) => Effect.Effect<AbsolutePath[], WorktreeError>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/git/git/Service") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const fs = yield* SandboxIO.FileSystem;
		const shell = yield* SandboxIO.Shell;

		// Arguments go through `execArgv`, never a command string: branch names and
		// paths are caller-supplied, and a space or `$(…)` in one must stay data.
		const execute = (cwd: string) => (args: string[], options?: { readonly env?: Record<string, string> }) =>
			shell
				.execArgv(["git", ...args], {
					cwd,
					...(options?.env === undefined ? {} : { env: options.env }),
				})
				.pipe(
					Effect.map(
						(result) =>
							({
								exitCode: result.exitCode,
								text: result.stdout,
								stderr: result.stderr,
							}) satisfies Result,
					),
					Effect.mapError((cause) => new AppProcessError({ command: ["git", ...args].join(" "), cause })),
				);

		const run = (cwd: string) => (args: string[]) =>
			execute(cwd)(args).pipe(Effect.orElseSucceed(() => ({ exitCode: 1, text: "", stderr: "" })));

		const find = Effect.fn("Git.find")(function* (input: AbsolutePath) {
			const dotgit = yield* SandboxFs.up(fs, { targets: [".git"], start: input }).pipe(
				Effect.map((matches) => matches[0]),
			);
			if (!dotgit) return undefined;

			const cwd = path.dirname(dotgit);
			const git = run(cwd);
			const topLevel = yield* git(["rev-parse", "--show-toplevel"]);
			const commonDir = yield* git(["rev-parse", "--git-common-dir"]);
			if (commonDir.exitCode !== 0) return undefined;

			const directory = topLevel.exitCode === 0 ? resolvePath(cwd, topLevel.text) : cwd;
			return {
				directory: AbsolutePath.make(directory),
				store: AbsolutePath.make(resolvePath(directory, commonDir.text)),
			} satisfies Repo;
		});

		const remote = Effect.fn("Git.remote")(function* (repo: Repo, name = "origin") {
			const result = yield* run(repo.directory)(["remote", "get-url", name]);
			if (result.exitCode !== 0) return undefined;
			return result.text.trim() || undefined;
		});

		const roots = Effect.fn("Git.roots")(function* (repo: Repo) {
			const result = yield* run(repo.directory)(["rev-list", "--max-parents=0", "HEAD"]);
			if (result.exitCode !== 0) return [];
			return result.text
				.split("\n")
				.map((item) => item.trim())
				.filter(Boolean)
				.toSorted();
		});

		const origin = Effect.fn("Git.origin")(function* (directory: string) {
			const result = yield* run(directory)(["config", "--get", "remote.origin.url"]);
			if (result.exitCode !== 0) return undefined;
			return result.text.trim() || undefined;
		});

		const head = Effect.fn("Git.head")(function* (directory: string) {
			const result = yield* run(directory)(["rev-parse", "HEAD"]);
			if (result.exitCode !== 0) return undefined;
			return result.text.trim() || undefined;
		});

		const dir = Effect.fn("Git.dir")(function* (directory: string) {
			const result = yield* run(directory)(["rev-parse", "--git-dir"]);
			if (result.exitCode !== 0) return undefined;
			return AbsolutePath.make(resolvePath(directory, result.text));
		});

		const branch = Effect.fn("Git.branch")(function* (directory: string) {
			const result = yield* run(directory)(["symbolic-ref", "--quiet", "--short", "HEAD"]);
			if (result.exitCode !== 0) return undefined;
			return result.text.trim() || undefined;
		});

		const remoteHead = Effect.fn("Git.remoteHead")(function* (directory: string) {
			const result = yield* run(directory)(["symbolic-ref", "refs/remotes/origin/HEAD"]);
			if (result.exitCode !== 0) return undefined;
			return result.text.trim().replace(/^refs\/remotes\//, "") || undefined;
		});

		const clone = Effect.fn("Git.clone")(
			(input: { remote: string; target: string; branch?: string; depth?: number }) =>
				execute(path.dirname(input.target))([
					"clone",
					"--depth",
					String(input.depth ?? 100),
					...(input.branch ? ["--branch", input.branch] : []),
					"--",
					input.remote,
					input.target,
				]),
		);

		const fetch = Effect.fn("Git.fetch")((directory: string) => execute(directory)(["fetch", "--all", "--prune"]));

		const fetchBranch = Effect.fn("Git.fetchBranch")((directory: string, branch: string) =>
			execute(directory)(["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]),
		);

		const checkout = Effect.fn("Git.checkout")((directory: string, branch: string) =>
			execute(directory)(["checkout", "-B", branch, `origin/${branch}`]),
		);

		const reset = Effect.fn("Git.reset")((directory: string, target: string) =>
			execute(directory)(["reset", "--hard", target]),
		);

		const push = Effect.fn("Git.push")(
			(input: {
				readonly directory: string;
				readonly refspec: string;
				readonly remote?: string;
				readonly env?: Record<string, string>;
			}) =>
				execute(input.directory)(
					["push", "--", input.remote ?? "origin", input.refspec],
					input.env === undefined ? undefined : { env: input.env },
				),
		);

		const worktree = Effect.fnUntraced(function* (
			operation: "create" | "remove" | "list",
			repo: Repo,
			args: string[],
			worktreeDirectory?: AbsolutePath,
			cwd = repo.directory,
		) {
			const result = yield* execute(cwd)(args).pipe(
				Effect.mapError(
					(cause) =>
						new WorktreeError({
							operation,
							directory: worktreeDirectory,
							message: cause.message,
							cause,
						}),
				),
			);
			if (result.exitCode === 0) return result.text;
			return yield* new WorktreeError({
				operation,
				directory: worktreeDirectory,
				message: result.stderr.trim() || result.text.trim() || "Git failed",
			});
		});

		const worktreeCreate = Effect.fn("Git.worktreeCreate")(function* (input: {
			repo: Repo;
			directory: AbsolutePath;
		}) {
			yield* worktree(
				"create",
				input.repo,
				["worktree", "add", "--detach", input.directory, "HEAD"],
				input.directory,
			);
		});

		const worktreeRemove = Effect.fn("Git.worktreeRemove")(function* (input: {
			repo: Repo;
			directory: AbsolutePath;
		}) {
			yield* worktree(
				"remove",
				input.repo,
				["worktree", "remove", "--force", input.directory],
				input.directory,
				input.repo.store,
			);
		});

		const worktreeList = Effect.fn("Git.worktreeList")(function* (repo: Repo) {
			return (yield* worktree("list", repo, ["worktree", "list", "--porcelain"]))
				.split("\n")
				.filter((line) => line.startsWith("worktree "))
				.map((line) => AbsolutePath.make(resolvePath(repo.directory, line.slice("worktree ".length).trim())));
		});

		return Service.of({
			find,
			remote,
			roots,
			origin,
			head,
			dir,
			branch,
			remoteHead,
			clone,
			fetch,
			fetchBranch,
			checkout,
			reset,
			push,
			worktreeCreate,
			worktreeRemove,
			worktreeList,
		});
	}),
);

/**
 * Run git inside the given sandbox — local, remote, or virtual. The sandbox
 * supplies both halves: repository discovery walks its filesystem and commands
 * run through its shell, so git can never read files in one place and execute
 * in another.
 *
 * The sandbox must have a real `git` binary. A VFS-backed shell (`EnvBash`) has
 * builtins only, so commands there exit 127 and `find` reports no repository.
 */
export const layerWith = <E, RIn>(sandbox: Sandbox.Sandbox<E, RIn>) => layer.pipe(Layer.provide(sandbox));

export const defaultLayer = (rootPath: string) => layerWith(Sandbox.defaultLayer(rootPath));

function resolvePath(cwd: string, value: string) {
	const trimmed = value.replace(/[\r\n]+$/, "");
	if (!trimmed) return cwd;
	if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
	return path.resolve(cwd, trimmed);
}

export * as Git from "./git.ts";
