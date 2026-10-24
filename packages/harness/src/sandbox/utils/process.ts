import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node";
import { type Duration, Effect, Layer, Option } from "effect";
import { ChildProcessSpawner } from "effect/process";

/**
 * Child processes spawn directly on the host operating system.
 * Note that host processes see the real filesystem, not the sandbox's virtual one.
 **/
export const host = NodeChildProcessSpawner.layer.pipe(Layer.provide([NodeFileSystem.layer, NodePath.layer]));

/**
 * Virtual sandboxes have no operating system behind them; attempting to run
 * a child process is a wiring mistake, surfaced as a defect.
 **/
export const unsupported = Layer.succeed(
	ChildProcessSpawner.ChildProcessSpawner,
	ChildProcessSpawner.make(() => Effect.die(new Error("process execution is not supported by this sandbox"))),
);

const signalGroup = (handle: ChildProcessSpawner.ChildProcessHandle, signal: NodeJS.Signals) =>
	Effect.sync(() => {
		try {
			process.kill(-Number(handle.pid), signal);
		} catch {
			// the group is already gone
		}
	});

/**
 * Stops a spawned process and its group.
 *
 * The spawner's own release sends SIGTERM and then waits for exit, so a process
 * that ignores SIGTERM (and children inheriting that) would make a scope close
 * wait forever. This SIGTERMs the leader, SIGKILLs it if it outlives
 * `forceKillAfter`, then SIGKILLs whatever is left of the group — children can
 * outlive a leader that already exited.
 *
 * `graceful` gives the rest of the group a SIGTERM first: when the leader has
 * already exited it SIGTERMs the group (children that dropped their pipes
 * included), and SIGKILLs it `forceKillAfter` later only while a pipe is still
 * open. Otherwise an exited leader whose pipes are closed leaves the group alone.
 */
export const terminate = (
	handle: ChildProcessSpawner.ChildProcessHandle,
	options: { readonly forceKillAfter: Duration.Input; readonly pipesOpen: boolean; readonly graceful?: boolean },
) =>
	Effect.gen(function* () {
		const running = yield* handle.isRunning.pipe(Effect.orElseSucceed(() => false));
		if (!running) {
			if (options.graceful) {
				yield* signalGroup(handle, "SIGTERM");
				if (!options.pipesOpen) return;
				yield* Effect.sleep(options.forceKillAfter);
			} else if (!options.pipesOpen) return;
			return yield* signalGroup(handle, "SIGKILL");
		}
		yield* handle.kill({ killSignal: "SIGTERM" }).pipe(
			Effect.timeoutOption(options.forceKillAfter),
			Effect.flatMap(
				Option.match({
					onSome: () => Effect.void,
					onNone: () => handle.kill({ killSignal: "SIGKILL" }),
				}),
			),
			Effect.ignore,
		);
		yield* signalGroup(handle, "SIGKILL");
	});

export * as Process from "./process.ts";
