import { Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { type ExecResult, Shell, ShellError, type ShellOptions } from "./shell";

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
}

const DEFAULT_SHELL = "sh";

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
			const run = (label: string, file: string, args: ReadonlyArray<string>, opts?: ShellOptions) =>
				Effect.scoped(
					Effect.gen(function* () {
						const handle = yield* spawner.spawn(
							ChildProcess.make(file, [...args], {
								cwd: opts?.cwd,
								env: { ...options.env, ...opts?.env },
								extendEnv: true,
								stdin: "ignore",
								stdout: "pipe",
								stderr: "pipe",
							}),
						);
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

			return Shell.of({ exec, execArgv });
		}),
	);

export * as HostExe from "./host";
