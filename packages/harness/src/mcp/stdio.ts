import { type JSONRPCMessage, ReadBuffer, serializeMessage, type Transport } from "@modelcontextprotocol/client";
import { Cause, Duration, Effect, Fiber, Option, Queue, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Process } from "../sandbox/utils/process.ts";
import { StdioError } from "./error.ts";

/** How long a server gets to exit on its own after stdin closes, before it is terminated. */
const CLOSE_GRACE = Duration.seconds(2);
/** Escalate SIGTERM to SIGKILL after this long. */
const FORCE_KILL_AFTER = Duration.seconds(2);
const OUTGOING_CAPACITY = 64;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
// An unexpected exit is reported with its exit code and the end of stderr, which usually names the cause.
const EXIT_WAIT = Duration.seconds(1);
const STDERR_TAIL = 2_000;

/** Process groups of running servers, terminated if the host exits without closing them. */
const live = new Set<number>();
let exitHook = false;
const track = (pid: number) => {
	if (process.platform === "win32") return () => {};
	if (!exitHook) {
		exitHook = true;
		process.once("exit", () => {
			for (const group of live) {
				try {
					process.kill(-group, "SIGTERM");
				} catch {
					// the group is already gone
				}
			}
		});
	}
	live.add(pid);
	return () => {
		live.delete(pid);
	};
};

export interface Options {
	/** Server name; only used to attribute logs. */
	readonly server: string;
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	readonly cwd: string;
	/** Environment declared by the server config, merged over the host's. */
	readonly env: Record<string, string>;
}

/**
 * MCP stdio transport for a server process on the host.
 *
 * The process is acquired in the calling scope: closing the scope kills it and its process group,
 * whether or not the transport was closed.
 */
export const make = Effect.fn("McpStdio.make")(function* (options: Options) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const scope = yield* Effect.scope;
	const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
	// Outgoing frames are queued rather than written to `handle.stdin` directly: the sink closes the
	// stream it is run with, and stdin must stay open across the whole connection.
	const outgoing = yield* Queue.bounded<string, Cause.Done>(OUTGOING_CAPACITY);
	const buffer = new ReadBuffer({ maxBufferSize: MAX_FRAME_BYTES });
	const state: {
		phase: "ready" | "starting" | "open" | "closed";
		handle?: ChildProcessSpawner.ChildProcessHandle | undefined;
		stdoutOpen: boolean;
		stderrOpen: boolean;
	} = { phase: "ready", stdoutOpen: false, stderrOpen: false };
	let startup: Promise<void> | undefined;
	let closing: Promise<void> | undefined;
	let untrack = () => {};
	let outputStarted = false;
	// Set when reading stdout failed (an oversized frame), which then explains the close instead of an exit.
	let broken = false;
	let stderr = "";

	const stop = (handle: ChildProcessSpawner.ChildProcessHandle) =>
		Effect.timeoutOption(handle.exitCode, CLOSE_GRACE).pipe(
			Effect.ignore,
			Effect.andThen(
				Effect.suspend(() =>
					Process.terminate(handle, {
						forceKillAfter: FORCE_KILL_AFTER,
						pipesOpen: state.stdoutOpen || state.stderrOpen,
						graceful: true,
					}),
				),
			),
			Effect.ensuring(Effect.sync(() => untrack())),
		);

	const close = () =>
		(closing ??= runPromise(
			Effect.gen(function* () {
				state.phase = "closed";
				Queue.endUnsafe(outgoing);
				if (startup) yield* Effect.promise(() => startup!.catch(() => undefined));
				const handle = state.handle;
				if (!handle) {
					// Closed before output was read (spawn failed, or closed while starting): nothing else reports it.
					if (!outputStarted) transport.onclose?.();
					return;
				}
				state.handle = undefined;
				yield* stop(handle);
			}).pipe(Effect.ensuring(Queue.shutdown(outgoing)), Effect.ensuring(Effect.sync(() => buffer.clear()))),
		));

	const transport: Transport = {
		start: () => {
			if (state.phase !== "ready")
				return Promise.reject(new StdioError({ message: "stdio transport already started" }));
			state.phase = "starting";
			startup = runPromise(
				Effect.gen(function* () {
					const handle = yield* spawner
						.spawn(
							ChildProcess.make(options.command, [...options.args], {
								cwd: options.cwd,
								env: options.env,
								extendEnv: true,
								stdin: { stream: Stream.encodeText(Stream.fromQueue(outgoing)), endOnDone: true },
								stdout: "pipe",
								stderr: "pipe",
								forceKillAfter: FORCE_KILL_AFTER,
							}),
						)
						.pipe(
							Effect.mapError((error) => {
								if (error.reason._tag !== "NotFound") return error;
								// The spawner checks the working directory before it spawns, with the same tag.
								return error.reason.method === "spawn"
									? new StdioError({ message: `command not found: ${options.command}` })
									: new StdioError({ message: `working directory not found: ${options.cwd}` });
							}),
						);
					state.handle = handle;
					state.stdoutOpen = true;
					state.stderrOpen = true;
					untrack = track(Number(handle.pid));
					yield* Effect.addFinalizer(() => Effect.sync(() => untrack()));
					if (state.phase === "closed") {
						state.handle = undefined;
						return yield* stop(handle);
					}
					state.phase = "open";
					yield* startOutput(handle);
				}).pipe(Scope.provide(scope)),
			);
			return startup;
		},
		send: (message: JSONRPCMessage) =>
			state.phase !== "open"
				? Promise.reject(new StdioError({ message: "not connected" }))
				: runPromise(
						Queue.offer(outgoing, serializeMessage(message)).pipe(
							Effect.flatMap((offered) =>
								offered ? Effect.void : Effect.fail(new StdioError({ message: "not connected" })),
							),
						),
					),
		close,
	};

	const deliver = (chunk: Uint8Array) =>
		Effect.gen(function* () {
			yield* Effect.try({
				try: () => buffer.append(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
				catch: () => new StdioError({ message: "mcp stdio frame exceeded 16 MiB" }),
			});
			while (true) {
				// `undefined` means the frame failed to parse: the buffer has already advanced past it, so
				// keep draining. `null` means the buffer holds no complete frame yet.
				const message = yield* Effect.try({
					try: () => buffer.readMessage(),
					catch: (cause) => new StdioError({ message: cause instanceof Error ? cause.message : String(cause) }),
				}).pipe(
					Effect.catch((error) =>
						Effect.sync(() => {
							transport.onerror?.(error);
							return undefined;
						}),
					),
				);
				if (message === undefined) continue;
				if (message === null) return;
				transport.onmessage?.(message);
			}
		});

	const startOutput = (handle: ChildProcessSpawner.ChildProcessHandle) =>
		Effect.gen(function* () {
			outputStarted = true;
			// Drain stderr into the debug log so chatty servers cannot stall on a full pipe.
			const drain = yield* Effect.forkScoped(
				handle.stderr.pipe(
					Stream.decodeText(),
					Stream.tap((output) => Effect.sync(() => (stderr = (stderr + output).slice(-STDERR_TAIL)))),
					Stream.runForEach((output) =>
						output.trim() === ""
							? Effect.void
							: Effect.logDebug("mcp server stderr", { server: options.server, output }),
					),
					Effect.ignore,
					// A descendant holding only stderr keeps the group alive, and the group id ours.
					Effect.ensuring(
						Effect.sync(() => {
							state.stderrOpen = false;
						}),
					),
				),
			);

			yield* Effect.forkScoped(
				Stream.runForEach(handle.stdout, deliver).pipe(
					Effect.tapCause((cause) =>
						Effect.sync(() => {
							if (Cause.hasInterruptsOnly(cause)) return;
							broken = true;
							const error = Cause.squash(cause);
							transport.onerror?.(error instanceof Error ? error : new StdioError({ message: String(error) }));
						}),
					),
					Effect.ignore,
					// stdout ending means the server is gone.
					Effect.ensuring(
						Effect.gen(function* () {
							state.stdoutOpen = false;
							if (state.phase !== "closed") {
								if (!broken) {
									// stdout can end before the final stderr output has been read. A grandchild holding
									// stderr open must not cost the exit code, so each wait is bounded separately.
									yield* Fiber.await(drain).pipe(Effect.timeoutOption(EXIT_WAIT), Effect.ignore);
									const code = yield* handle.exitCode.pipe(
										Effect.timeoutOption(EXIT_WAIT),
										Effect.orElseSucceed(() => Option.none()),
									);
									const exited = Option.match(code, {
										onNone: () => "mcp server process exited",
										onSome: (code) => `mcp server process exited with code ${code}`,
									});
									const output = stderr.trim();
									transport.onerror?.(new StdioError({ message: output ? `${exited}: ${output}` : exited }));
								}
								yield* Effect.promise(close);
							}
							transport.onclose?.();
						}),
					),
				),
			);
		});

	return { transport, stderr: () => stderr };
});

export * as McpStdio from "./stdio.ts";
