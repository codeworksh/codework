import { Context, Duration, Effect, Layer, Option, Schema, Stream } from "effect";
import { Shell } from "../sandbox/shell/shell.ts";

/**
 * `ToolShell` — the tool-owned, cancellable command-execution capability the bash tool depends on.
 *
 * It deliberately does **not** reuse `sandbox/Shell` directly: `sandbox/Shell`
 * models no timeout, and `ToolShell` makes it part of the contract. Every
 * backend reaches it through {@link fromSandboxShell}; the process dies
 * mid-flight where the backend can kill it (host, Vercel) and the call returns
 * at the deadline either way.
 */

/** Infra/spawn failure — not model-actionable; handlers should treat it as a defect. */
export class ToolShellError extends Schema.TaggedError<ToolShellError>()("ToolShellError", {
	command: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

/** The command exceeded its deadline. Distinct so handlers can map it to a domain timeout. */
export class ToolShellTimeout extends Schema.TaggedError<ToolShellTimeout>()("ToolShellTimeout", {
	command: Schema.String,
	timeoutMillis: Schema.Finite,
}) {}

export interface ToolShellResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

export interface ToolShellExecOptions {
	readonly cwd?: string;
	readonly env?: Record<string, string>;
	readonly timeout?: Duration.Input;
}

const widenExecError = <A>(
	effect: Effect.Effect<A, ToolShellError>,
): Effect.Effect<A, ToolShellError | ToolShellTimeout> =>
	effect.pipe(Effect.mapError((error): ToolShellError | ToolShellTimeout => error));

/**
 * A streamed shell event: interleaved output chunks, terminated by a single
 * `Exit` carrying the exit code. (A stream has no separate "final value", so the
 * exit rides as the last element.)
 */
export type ToolShellEvent =
	| { readonly _tag: "Output"; readonly channel: "stdout" | "stderr"; readonly bytes: Uint8Array }
	| { readonly _tag: "Exit"; readonly exitCode: number };

export interface IToolShell {
	/**
	 * Run a command to completion. Cancellable by contract: fiber interruption
	 * returns control, and `timeout` bounds the command. Whether the underlying
	 * process dies mid-flight depends on the adapter.
	 */
	readonly exec: (
		command: string,
		options?: ToolShellExecOptions,
	) => Effect.Effect<ToolShellResult, ToolShellError | ToolShellTimeout>;
	/**
	 * Optional streaming output (variant B): combined stdout/stderr chunks then a
	 * terminal `Exit`. Absent → the tool falls back to {@link exec}. The process
	 * is killed when the consuming scope closes (interrupt / timeout), so the
	 * *consumer* owns the deadline and keeps whatever output it accumulated.
	 */
	readonly stream?: (command: string, options?: ToolShellExecOptions) => Stream.Stream<ToolShellEvent, ToolShellError>;
}

export class ToolShell extends Context.Service<ToolShell, IToolShell>()("@codeworksh/harness/tool/shell/ToolShell") {}

/**
 * Bridge the existing `sandbox/Shell` into a `ToolShell`. Used for just-bash
 * (in-process) and remote providers.
 *
 * `cwd` and `env` both pass through to the backing `sandbox/Shell`, which
 * resolves a relative `cwd` against its mount. The buffered `exec`
 * timeout is enforced here with `Effect.timeoutOption` (interruption always
 * returns control; the underlying command is only truly killed mid-flight on
 * signal-aware backends, handled in the provider layer). When the backend exposes
 * `stream` (e.g. Vercel `Command.logs`), it is bridged to {@link IToolShell.stream}
 * so the bash tool streams over it too.
 */
export const fromSandboxShell: Layer.Layer<ToolShell, never, Shell> = Layer.effect(
	ToolShell,
	Effect.gen(function* () {
		const shell = yield* Shell;

		const exec: IToolShell["exec"] = (command, options) => {
			const run = shell
				.exec(command, {
					...(options?.env ? { env: options.env } : {}),
					...(options?.cwd ? { cwd: options.cwd } : {}),
				})
				.pipe(Effect.mapError((cause) => new ToolShellError({ command, cause })));

			if (options?.timeout === undefined) return widenExecError(run);

			const timeout = options.timeout;
			return run.pipe(
				Effect.timeoutOption(timeout),
				Effect.flatMap(
					Option.match({
						onNone: () =>
							Effect.fail(new ToolShellTimeout({ command, timeoutMillis: Duration.toMillis(timeout) })),
						onSome: Effect.succeed,
					}),
				),
			);
		};

		// Bridge the backend's optional streaming (e.g. Vercel `Command.logs`) into
		// `ToolShell.stream`: stdout/stderr chunks fold into `Output`, `exit` into
		// `Exit`. The deadline for the streaming path is the consumer's (the bash tool).
		const sandboxStream = shell.stream;
		const stream: IToolShell["stream"] = sandboxStream
			? (command, options) =>
					sandboxStream(command, {
						...(options?.env ? { env: options.env } : {}),
						...(options?.cwd ? { cwd: options.cwd } : {}),
					}).pipe(
						Stream.map((chunk): ToolShellEvent =>
							chunk._tag === "exit"
								? { _tag: "Exit", exitCode: chunk.exitCode }
								: { _tag: "Output", channel: chunk._tag, bytes: chunk.bytes },
						),
						Stream.mapError((cause) => new ToolShellError({ command, cause })),
					)
			: undefined;

		return ToolShell.of(stream ? { exec, stream } : { exec });
	}),
);
