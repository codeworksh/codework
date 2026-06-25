import { Context, type Effect, Schema, type Stream } from "effect";

/**
 * The pluggable execution contract. Local sandboxes usually get a Shell through
 * just-bash over the local `Virtual.Vfs`; remote sandboxes provide their own
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
	 * Optional streaming output: stdout/stderr chunks then a terminal `exit`.
	 * Backends that can stream (e.g. Vercel) implement it; `ToolShell.fromSandboxShell`
	 * bridges it to `ToolShell.stream` so the bash tool streams over them too.
	 */
	readonly stream?: (
		command: string,
		options?: { env?: Record<string, string> },
	) => Stream.Stream<ExecChunk, ShellError>;
}

/** Execution service — the live {@link ISandboxExe} for the active sandbox. */
export class Shell extends Context.Service<Shell, ISandboxExe>()("@codework/sandbox/shell") {}
