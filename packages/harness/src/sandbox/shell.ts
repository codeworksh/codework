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
	readonly exec: (
		command: string,
		options?: { env?: Record<string, string> },
	) => Effect.Effect<ExecResult, ShellError>;
	/**
	 * Run a program with an explicit argument vector, bypassing shell word
	 * splitting. Callers that build commands from untrusted values — branch
	 * names, file paths — must use this instead of interpolating into
	 * {@link exec}, where a space or `$(…)` would change what runs.
	 *
	 * Backends whose transport only accepts a string quote the vector with
	 * {@link quote}; backends that spawn directly pass it through untouched.
	 */
	readonly execArgv: (
		argv: ReadonlyArray<string>,
		options?: { env?: Record<string, string>; cwd?: string },
	) => Effect.Effect<ExecResult, ShellError>;
	/**
	 * Optional streaming output: stdout/stderr chunks then a terminal `exit`.
	 * Backends that can stream (e.g. Vercel) implement it; `ToolShell.fromSandboxShell`
	 * bridges it to `ToolShell.stream` so the bash tool streams over them too.
	 */
	readonly stream?: (
		command: string,
		options?: { env?: Record<string, string> },
	) => Stream.Stream<ExecChunk, ShellError>;
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
 * through `exec`, with `cwd` applied as a leading `cd`. Backends that spawn a
 * real argument vector (Vercel) implement `execArgv` themselves instead, so the
 * args never meet a shell parser at all.
 */
export const fromExec = (backend: Omit<ISandboxExe, "execArgv">): ISandboxExe => ({
	...backend,
	execArgv: (argv, options) => {
		const command = quoteArgv(argv);
		return backend.exec(options?.cwd === undefined ? command : `cd ${quote(options.cwd)} && ${command}`, options);
	},
});

/** Execution service — the live {@link ISandboxExe} for the active sandbox. */
export class Shell extends Context.Service<Shell, ISandboxExe>()("@codework/sandbox/shell") {}
