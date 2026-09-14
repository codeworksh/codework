import { Context, Effect, Layer, Schema } from "effect";
import { posix as path } from "../util/posix.ts";
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

export interface Result {
	readonly exitCode: number;
	readonly text: string;
	readonly stderr: string;
}

export type RevParse = "--show-toplevel" | "--git-dir" | "--git-common-dir";

export interface Interface {
	/** Run `git <args>` in `directory`; fails only when the process cannot be spawned. */
	readonly exec: (directory: string, args: ReadonlyArray<string>) => Effect.Effect<Result, AppProcessError>;
	readonly revParse: (directory: string, arg: RevParse) => Effect.Effect<string | undefined>;
	readonly remote: (directory: string, name?: string) => Effect.Effect<string | undefined>;
	readonly roots: (directory: string) => Effect.Effect<string[]>;
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
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/git/git/Service") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const shell = yield* SandboxIO.Shell;

		// Arguments go through `execArgv`, never a command string: branch names and
		// paths are caller-supplied, and a space or `$(…)` in one must stay data.
		const execute =
			(cwd: string) => (args: ReadonlyArray<string>, options?: { readonly env?: Record<string, string> }) =>
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

		const run = (cwd: string) => (args: ReadonlyArray<string>) =>
			execute(cwd)(args).pipe(Effect.orElseSucceed(() => ({ exitCode: 1, text: "", stderr: "" })));

		const exec = Effect.fn("Git.exec")((directory: string, args: ReadonlyArray<string>) => execute(directory)(args));

		const revParse = Effect.fn("Git.revParse")(function* (directory: string, arg: RevParse) {
			const result = yield* run(directory)(["rev-parse", arg]);
			if (result.exitCode !== 0) return undefined;
			return resolvePath(directory, result.text);
		});

		const remote = Effect.fn("Git.remote")(function* (directory: string, name = "origin") {
			const result = yield* run(directory)(["remote", "get-url", name]);
			if (result.exitCode !== 0) return undefined;
			return result.text.trim() || undefined;
		});

		const roots = Effect.fn("Git.roots")(function* (directory: string) {
			const result = yield* run(directory)(["rev-list", "--max-parents=0", "HEAD"]);
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
			const result = yield* revParse(directory, "--git-dir");
			return result === undefined ? undefined : AbsolutePath.make(result);
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

		return Service.of({
			exec,
			revParse,
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
		});
	}),
);

/**
 * Run git inside the given sandbox — local, remote, or virtual. Every command
 * goes through the sandbox shell, so git never executes anywhere other than
 * where the caller's files live. Discovery and identity live in `repo/`,
 * worktree management in `worktree/`; this module is only the command runner.
 *
 * The sandbox must have a real `git` binary. A VFS-backed shell (`EnvBash`) has
 * builtins only, so commands there exit 127 and every probe reports nothing.
 */
export const layerWith = <E, RIn>(sandbox: Sandbox.Sandbox<E, RIn>) => layer.pipe(Layer.provide(sandbox));

export const defaultLayer = (rootPath: string) => layerWith(Sandbox.defaultLayer(rootPath));

/** Resolve a (possibly relative) git output path against `cwd`, trimming the trailing newline. */
export function resolvePath(cwd: string, value: string) {
	const trimmed = value.replace(/[\r\n]+$/, "");
	if (!trimmed) return cwd;
	if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
	return path.resolve(cwd, trimmed);
}

export * as Git from "./git.ts";
