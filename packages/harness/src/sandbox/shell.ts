import { Context, type Effect, Schema, type Stream } from "effect";
import { posix as path } from "node:path";

/**
 * The pluggable execution contract. Local sandboxes usually get a Shell through
 * just-bash over the local `Local.Vfs`; remote sandboxes provide their own
 * native Shell. Either way the rest of the harness depends only on this service
 * tag.
 */

export class ShellError extends Schema.TaggedErrorClass<ShellError>()("ShellError", {
	command: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

export interface ExecResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

/**
 * One options shape for every entry point. `cwd` is the operation-level
 * override: it wins over the mount's working directory, and a relative value
 * resolves against it. Neither mutates shared state, so concurrent commands in
 * one mount can run in different directories.
 */
export interface ShellOptions {
	readonly env?: Record<string, string>;
	readonly cwd?: string;
}

/**
 * A streamed chunk of command output, terminated by a single `exit` carrying the
 * exit code. (A backend-level mirror of the tool layer's event; kept here so
 * `sandbox/` does not depend on `tools/`.)
 */
export type ExecChunk =
	| { readonly _tag: "stdout"; readonly bytes: Uint8Array }
	| { readonly _tag: "stderr"; readonly bytes: Uint8Array }
	| { readonly _tag: "exit"; readonly exitCode: number };

/**
 * The command-execution capability a sandbox exposes. For an in-process
 * backend this is just-bash; for a remote backend it is the sandbox's own
 * shell. The {@link Shell} service tag carries this interface.
 */
export interface ISandboxExe {
	readonly exec: (command: string, options?: ShellOptions) => Effect.Effect<ExecResult, ShellError>;
	/**
	 * Run a program with an explicit argument vector, bypassing shell word
	 * splitting. Callers that build commands from untrusted values — branch
	 * names, file paths — must use this instead of interpolating into
	 * {@link exec}, where a space or `$(…)` would change what runs.
	 *
	 * Backends whose transport only accepts a string quote the vector with
	 * {@link quote}; backends that spawn directly pass it through untouched.
	 */
	readonly execArgv: (argv: ReadonlyArray<string>, options?: ShellOptions) => Effect.Effect<ExecResult, ShellError>;
	/**
	 * Optional streaming output: stdout/stderr chunks then a terminal `exit`.
	 * Backends that can stream (e.g. Vercel) implement it; `ToolShell.fromSandboxShell`
	 * bridges it to `ToolShell.stream` so the bash tool streams over them too.
	 */
	readonly stream?: (command: string, options?: ShellOptions) => Stream.Stream<ExecChunk, ShellError>;
}

/**
 * POSIX single-quote escaping: wrap in `'…'` and rewrite each embedded quote as
 * `'\''`. Everything inside single quotes is literal to the shell, so this is
 * safe for arbitrary bytes.
 */
export const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Render an argument vector as one shell-safe command string. */
export const quoteArgv = (argv: ReadonlyArray<string>) => argv.map(quote).join(" ");

/**
 * Resolve a per-command cwd against the sandbox cwd. Passing a relative cwd
 * straight to a host or remote process API would otherwise resolve it against
 * that API's own default, which need not be the filesystem's configured cwd.
 */
export const resolveCwd = (base: string | undefined, cwd: string | undefined) => {
	if (cwd === undefined || path.isAbsolute(cwd) || base === undefined) return cwd ?? base;
	return path.resolve(base, cwd);
};

/**
 * Complete a string-only backend: `execArgv` quotes the vector and runs it
 * through `exec`. Backends that spawn a real argument vector (Vercel) implement
 * `execArgv` themselves instead, so the args never meet a shell parser at all.
 *
 * `cwd` rides the options rather than a `cd <dir> && …` prefix. Every backend
 * we wrap takes a working directory natively, and the prefix form cannot tell a
 * failed `cd` from a failed command — both arrive as one exit code.
 */
export const fromExec = (backend: Omit<ISandboxExe, "execArgv">): ISandboxExe => ({
	...backend,
	execArgv: (argv, options) => backend.exec(quoteArgv(argv), options),
});

/**
 * Bind a cwd-neutral backend to one mount's working directory.
 *
 * The transport is shared between mounts and must stay rooted at the namespace
 * root, so the directory cannot live inside it: two mounts at different
 * directories would otherwise see each other's. This wrapper is per mount, and
 * an operation-level `cwd` still wins — resolved against the mount's, so a
 * relative one means what it reads like.
 */
export const withCwd = (backend: ISandboxExe, cwd: string): ISandboxExe => {
	const at = (options?: ShellOptions): ShellOptions => ({ ...options, cwd: resolveCwd(cwd, options?.cwd) });
	const stream = backend.stream;
	return {
		exec: (command, options) => backend.exec(command, at(options)),
		execArgv: (argv, options) => backend.execArgv(argv, at(options)),
		...(stream === undefined ? {} : { stream: (command, options) => stream(command, at(options)) }),
	};
};

/** Execution service — the live {@link ISandboxExe} for the active sandbox. */
export class Shell extends Context.Service<Shell, ISandboxExe>()("@codework/sandbox/shell") {}
