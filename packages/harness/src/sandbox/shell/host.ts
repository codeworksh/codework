import { Duration, Effect, Exit, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Process } from "../utils/process.ts";
import { type ExecChunk, type ExecResult, Shell, ShellError, type ShellOptions } from "./shell.ts";

/**
 * A {@link Shell} backed by real host processes.
 *
 * This is the execution half of the default local sandbox: just-bash is an
 * in-process emulator over the VFS and cannot run an external binary, so any
 * sandbox that must invoke real programs (`git`, package managers) needs this
 * instead.
 *
 * `execArgv` spawns the vector directly — no shell, so nothing in an argument
 * can be interpreted as syntax. `exec` keeps the single-string contract by
 * going through `sh -c`.
 */

export interface Options {
	/** Environment entries merged over the inherited environment. */
	readonly env?: Record<string, string>;
	/** Shell used to interpret the string form of `exec`. */
	readonly shell?: string;
	/** Grace between SIGTERM and SIGKILL when a command is interrupted (default 1s). */
	readonly forceKillAfter?: Duration.Input;
}

const DEFAULT_SHELL = "sh";
const DEFAULT_FORCE_KILL_AFTER: Duration.Input = Duration.seconds(1);

export const layer = (options: Options = {}): Layer.Layer<Shell, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.effect(
		Shell,
		Effect.gen(function* () {
			// Captured once so each call resolves to `R = never`.
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

			// No base directory is read here. The shell and the filesystem must
			// agree on what a relative path means, and they do — because both take
			// it from the same mount rather than each deriving one. Reading
			// `vfs.cwd()` was the same reasoning applied one layer too low: it made
			// the pairing true for one mount and unrepresentable for two.
			const forceKillAfter = options.forceKillAfter ?? DEFAULT_FORCE_KILL_AFTER;

			// Registered after the spawn, the finalizer runs before the spawner's own
			// release, and only when the command was cut short (interrupt or
			// timeout). A command that completes keeps its background jobs.
			const spawn = (file: string, args: ReadonlyArray<string>, opts?: ShellOptions) =>
				Effect.gen(function* () {
					const spawned = yield* spawner.spawn(
						ChildProcess.make(file, [...args], {
							cwd: opts?.cwd,
							env: { ...options.env, ...opts?.env },
							extendEnv: true,
							stdin: "ignore",
							stdout: "pipe",
							stderr: "pipe",
						}),
					);
					let openPipes = 2;
					const track = <A, E>(stream: Stream.Stream<A, E>) =>
						stream.pipe(Stream.ensuring(Effect.sync(() => openPipes--)));
					const output = { stdout: track(spawned.stdout), stderr: track(spawned.stderr) };
					yield* Effect.addFinalizer((exit) =>
						Exit.isSuccess(exit)
							? Effect.void
							: Effect.suspend(() => Process.terminate(spawned, { forceKillAfter, pipesOpen: openPipes > 0 })),
					);
					return { exitCode: spawned.exitCode, ...output };
				});

			const run = (label: string, file: string, args: ReadonlyArray<string>, opts?: ShellOptions) =>
				Effect.scoped(
					Effect.gen(function* () {
						const handle = yield* spawn(file, args, opts);
						// stdout and stderr are drained concurrently with the exit wait:
						// a process that fills a pipe buffer would otherwise deadlock.
						return yield* Effect.all(
							{
								exitCode: handle.exitCode,
								stdout: handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
								stderr: handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
							},
							{ concurrency: "unbounded" },
						);
					}),
				).pipe(
					Effect.map((result): ExecResult => result),
					Effect.mapError((cause) => new ShellError({ command: label, cause })),
				);

			const exec = Effect.fn("HostShell.exec")((command: string, opts?: ShellOptions) =>
				run(command, options.shell ?? DEFAULT_SHELL, ["-c", command], opts),
			);

			// The vector is handed to the OS as-is; it never passes through a parser.
			const execArgv = Effect.fn("HostShell.execArgv")((argv: ReadonlyArray<string>, opts?: ShellOptions) =>
				argv.length === 0
					? Effect.fail(new ShellError({ command: "", cause: new Error("execArgv requires a program") }))
					: run(argv.join(" "), argv[0]!, argv.slice(1), opts),
			);

			// The process group dies with the consuming scope, so a consumer that
			// stops early (a deadline) keeps whatever output it already took.
			const stream = (command: string, opts?: ShellOptions): Stream.Stream<ExecChunk, ShellError> =>
				Stream.unwrap(
					Effect.map(spawn(options.shell ?? DEFAULT_SHELL, ["-c", command], opts), (handle) =>
						Stream.concat(
							Stream.merge(
								handle.stdout.pipe(Stream.map((bytes): ExecChunk => ({ _tag: "stdout", bytes }))),
								handle.stderr.pipe(Stream.map((bytes): ExecChunk => ({ _tag: "stderr", bytes }))),
							),
							Stream.fromEffect(
								Effect.map(handle.exitCode, (exitCode): ExecChunk => ({ _tag: "exit", exitCode })),
							),
						),
					),
				).pipe(Stream.mapError((cause) => new ShellError({ command, cause })));

			return Shell.of({ exec, execArgv, stream });
		}),
	);

export * as HostExe from "./host.ts";
