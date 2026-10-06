import { Context, Duration, Effect, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Shell } from "../sandbox/shell/shell.ts";

/**
 * `ToolShell` — the tool-owned, cancellable command-execution capability the bash tool depends on.
 *
 * It deliberately does **not** reuse `sandbox/Shell` directly: the local OS path
 * provides no `Shell` at all, and `sandbox/Shell` models neither cancellation
 * nor a timeout. `ToolShell` makes both part of the contract. Adapters honor the
 * mid-flight process kill where the SDK allows it (local, Vercel) and fall back
 * to the timeout where it does not (Daytona) — "kill where it's easy".
 *
 * Two modes, and Local has two variants:
 *   - Local / full OS shell  → {@link local} (default)
 *   - Local / just-bash      → {@link fromSandboxShell} over `EnvBash`
 *   - Remote / provider      → {@link fromSandboxShell} over `EnvDaytona` / `EnvVercel`
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
	/**
	 * Grace period before escalating SIGTERM → SIGKILL on cancel/timeout. Honored
	 * by `ToolShell.local`; overrides the adapter's configured default for this
	 * call. Other adapters ignore it.
	 */
	readonly forceKillAfter?: Duration.Input;
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
	| { readonly _tag: "Output"; readonly bytes: Uint8Array }
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
	 * Run a program with an explicit argument vector, bypassing shell word
	 * splitting — the same contract `SandboxIO.Shell.execArgv` offers, surfaced
	 * here so a tool that builds a command from caller-supplied values (a search
	 * pattern, a path) passes them as data instead of interpolating into
	 * {@link exec}, where a space or `$(…)` would change what runs.
	 */
	readonly execArgv?: (
		argv: ReadonlyArray<string>,
		options?: ToolShellExecOptions,
	) => Effect.Effect<ToolShellResult, ToolShellError | ToolShellTimeout>;
	/**
	 * Optional streaming output (variant B): combined stdout/stderr chunks then a
	 * terminal `Exit`. Absent → the tool falls back to {@link exec}. Offered by
	 * `ToolShell.local`. The process group is killed when the consuming scope
	 * closes (interrupt / timeout), so the *consumer* owns the deadline and keeps
	 * whatever output it accumulated.
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
								: { _tag: "Output", bytes: chunk.bytes },
						),
						Stream.mapError((cause) => new ToolShellError({ command, cause })),
					)
			: undefined;

		// Argv path: same contract as the buffered `exec`, but the command never
		// meets a shell parser — the backend receives the vector as data.
		const execArgv: NonNullable<IToolShell["execArgv"]> = (argv, options) => {
			const run = shell
				.execArgv(argv, {
					...(options?.env ? { env: options.env } : {}),
					...(options?.cwd ? { cwd: options.cwd } : {}),
				})
				.pipe(Effect.mapError((cause) => new ToolShellError({ command: argv.join(" "), cause })));

			if (options?.timeout === undefined) return widenExecError(run);

			const timeout = options.timeout;
			return run.pipe(
				Effect.timeoutOption(timeout),
				Effect.flatMap(
					Option.match({
						onNone: () =>
							Effect.fail(
								new ToolShellTimeout({ command: argv.join(" "), timeoutMillis: Duration.toMillis(timeout) }),
							),
						onSome: Effect.succeed,
					}),
				),
			);
		};

		return ToolShell.of(stream ? { exec, execArgv, stream } : { exec, execArgv });
	}),
);

/** Default shell used by {@link local}. */
const DEFAULT_SHELL = "bash";

/**
 * Grace period before escalating SIGTERM → SIGKILL on cancel/timeout. Without
 * this, a command that traps or ignores SIGTERM (and whose children inherit that
 * `SIG_IGN`) would keep the cleanup waiting forever, so the per-call `timeout`
 * would not be a hard bound. One second gives well-behaved processes room to
 * exit cleanly while keeping cancellation snappy.
 */
const DEFAULT_FORCE_KILL_AFTER: Duration.Input = Duration.seconds(1);

export interface LocalConfig {
	/** Default working directory for commands that don't specify one. */
	readonly cwd?: string;
	/** Shell binary used to run commands (default: "bash"). */
	readonly shell?: string;
	/** Extra environment merged over `process.env` (a call's own `env` wins). */
	readonly env?: Record<string, string>;
	/**
	 * How long to wait after SIGTERM before sending SIGKILL to the process group
	 * (default 1s). Guarantees the timeout/interrupt is a hard bound even for
	 * commands that ignore SIGTERM.
	 */
	readonly forceKillAfter?: Duration.Input;
}

/**
 * `ToolShell.local` — the default, most-used backend: a real OS shell.
 *
 * Built on Effect's `ChildProcessSpawner` (the same spawner wired as
 * `Sandbox.Process.host`), which spawns detached — its own process group on Unix
 * — and group-kills (negative-pid on Unix, `taskkill /T` on Windows) when the
 * scope closes. But the spawner's cleanup sends SIGTERM and then *awaits exit*,
 * so a command that traps/ignores SIGTERM (its children inherit that `SIG_IGN`)
 * would hang the cleanup — and the timeout would not be a hard bound.
 *
 * So we add an explicit escalation finalizer: on scope close (timeout or interrupt) it
 * SIGTERMs the group and, if the process has not exited within
 * `forceKillAfter`, SIGKILLs it (SIGKILL cannot be trapped). It is registered
 * after the spawn, so it runs *before* the spawner's own release — which then
 * sees an exited process and returns at once. No manual `killProcessTree`, no
 * `AbortSignal` plumbing, no `try/finally`.
 *
 * Provide the spawner where the runtime is assembled, e.g.
 * `ToolShell.local({ cwd }).pipe(Layer.provide(Sandbox.Process.host))`.
 */
export const local = (config?: LocalConfig): Layer.Layer<ToolShell, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.effect(
		ToolShell,
		Effect.gen(function* () {
			// Capture the spawner once so each call resolves to `R = never`.
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const shell = config?.shell ?? DEFAULT_SHELL;
			const configForceKillAfter = config?.forceKillAfter ?? DEFAULT_FORCE_KILL_AFTER;

			// Hard-bound cancellation. On scope close (timeout / interrupt), if the
			// process is still running, SIGTERM its group and escalate to SIGKILL after
			// the grace period. Registered after the spawn so it runs before the
			// spawner's own release — which would otherwise await exit and hang on a
			// SIGTERM-ignoring command. `handle.kill` targets the group, and the SIGTERM
			// kill awaits exit, so we bound it with `timeoutOption` and fall through to
			// the untrappable SIGKILL.
			const escalateKill = (handle: ChildProcessSpawner.ChildProcessHandle, grace: Duration.Input) =>
				Effect.gen(function* () {
					const running = yield* handle.isRunning.pipe(Effect.orElseSucceed(() => false));
					if (!running) return;
					yield* handle.kill({ killSignal: "SIGTERM" }).pipe(
						Effect.timeoutOption(grace),
						Effect.flatMap(
							Option.match({
								onSome: () => Effect.void,
								onNone: () => handle.kill({ killSignal: "SIGKILL" }),
							}),
						),
						Effect.ignore,
					);
				});

			// Spawn `program args` and collect output. `command` is the display form used
			// only to attribute a failure; the vector is what actually runs.
			const spawn = (
				program: string,
				args: ReadonlyArray<string>,
				command: string,
				options?: ToolShellExecOptions,
			): Effect.Effect<ToolShellResult, ToolShellError | ToolShellTimeout> => {
				// Per-call option wins, else the adapter default, else the built-in default.
				const forceKillAfter = options?.forceKillAfter ?? configForceKillAfter;
				const run = Effect.gen(function* () {
					const handle = yield* ChildProcess.make(program, args, {
						cwd: options?.cwd ?? config?.cwd,
						env: { ...config?.env, ...options?.env },
						extendEnv: true,
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
					});
					yield* Effect.addFinalizer(() => escalateKill(handle, forceKillAfter));

					// Drain both streams while waiting for exit.
					const collected = yield* Effect.all(
						{
							stdout: handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
							stderr: handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
							exitCode: handle.exitCode,
						},
						{ concurrency: "unbounded" },
					);
					return {
						stdout: collected.stdout,
						stderr: collected.stderr,
						exitCode: collected.exitCode,
					} satisfies ToolShellResult;
				}).pipe(
					Effect.scoped,
					Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
					Effect.mapError((cause) => new ToolShellError({ command, cause })),
				);

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

			const exec: IToolShell["exec"] = (command, options) => spawn(shell, ["-c", command], command, options);

			// Argv path: the program is spawned directly, so a caller-supplied pattern
			// or path can never be reinterpreted by a shell.
			const execArgv: NonNullable<IToolShell["execArgv"]> = (argv, options) => {
				const [program, ...args] = argv;
				if (program === undefined) return Effect.die(new Error("ToolShell.execArgv requires a program"));
				return spawn(program, args, argv.join(" "), options);
			};

			// Streaming: combined stdout/stderr chunks then a terminal `Exit`. The
			// process group is killed (with escalation) when the consuming scope closes,
			// so an interrupted/timed-out consumer keeps whatever it accumulated.
			// Note: `options` attributes can be used when a direct ToolShell caller (or a future tool) wants per-call cwd/env/forceKillAfter.
			// Otherwise fallback to `config`
			const stream: NonNullable<IToolShell["stream"]> = (command, options) => {
				const forceKillAfter = options?.forceKillAfter ?? configForceKillAfter;
				// `Stream.unwrap` ties the spawn's Scope to the stream's lifetime, so the
				// escalateKill finalizer runs when consumption ends or is interrupted.
				return Stream.unwrap(
					Effect.gen(function* () {
						const handle = yield* ChildProcess.make(shell, ["-c", command], {
							cwd: options?.cwd ?? config?.cwd,
							env: { ...config?.env, ...options?.env },
							extendEnv: true,
							stdin: "ignore",
							stdout: "pipe",
							stderr: "pipe",
						});
						yield* Effect.addFinalizer(() => escalateKill(handle, forceKillAfter));
						const output = handle.all.pipe(Stream.map((bytes): ToolShellEvent => ({ _tag: "Output", bytes })));
						const exit = Stream.fromEffect(handle.exitCode).pipe(
							Stream.map((exitCode): ToolShellEvent => ({ _tag: "Exit", exitCode })),
						);
						return Stream.concat(output, exit);
					}),
				).pipe(
					Stream.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
					Stream.mapError((cause) => new ToolShellError({ command, cause })),
				);
			};

			return ToolShell.of({ exec, execArgv, stream });
		}),
	);
