import { Context, type Effect, Schema } from "effect";

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
 * The command-execution capability a sandbox exposes. For an in-process
 * backend this is just-bash; for a remote backend it is the sandbox's own
 * shell. The {@link Shell} service tag carries this interface.
 */
export interface ISandboxExe {
	readonly exec: (
		command: string,
		options?: { env?: Record<string, string> },
	) => Effect.Effect<ExecResult, ShellError>;
}

/** Execution service — the live {@link ISandboxExe} for the active sandbox. */
export class Shell extends Context.Service<Shell, ISandboxExe>()("@codework/sandbox/shell") {}
