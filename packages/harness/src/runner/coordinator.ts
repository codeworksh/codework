/*
 * @file Coordinator provides the execution process manager (fibers).
 * Handles process concurrency and coordination for the provided drain function.
 */
import { Deferred, Effect, Exit, Fiber, FiberSet, Scope } from "effect";

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E, Reason = never> {
	/** Snapshots keys with an execution owned by this coordinator. */
	readonly active: Effect.Effect<ReadonlySet<Key>>;
	/** Starts an execution while idle, or joins the active execution and returns its exit. */
	readonly run: (key: Key) => Effect.Effect<void, E>;
	/** Rings the doorbell so newly recorded work is drained without waiting for it. */
	readonly wake: (key: Key) => Effect.Effect<void>;
	/** Accepts interruption of active work without waiting for cleanup to settle. */
	readonly interrupt: (key: Key, reason?: Reason) => Effect.Effect<boolean>;
	/** Resolves once no execution is active for the key. Never starts work. */
	readonly awaitIdle: (key: Key) => Effect.Effect<void>;
}

/** One process-local busy period for a key. */
type Execution<E, Reason> = {
	readonly done: Deferred.Deferred<void, E>;
	owner?: Fiber.Fiber<void>;
	pendingWake: boolean;
	stopping: boolean;
	interruptionReason?: Reason;
};

export const make = <Key, E, Reason = never>(options: {
	/** Actual work serialized by the coordinator. */
	readonly drain: (key: Key, force: boolean) => Effect.Effect<void, E>;
	/** Runs once when a busy period begins, before its first drain. */
	readonly started?: (key: Key) => Effect.Effect<void>;
	/** Runs after the final drain exits and before joiners are released. */
	readonly settled?: (key: Key, exit: Exit.Exit<void, E>, reason?: Reason) => Effect.Effect<void>;
}): Effect.Effect<Coordinator<Key, E, Reason>, never, Scope.Scope> =>
	Effect.gen(function* () {
		const executions = new Map<Key, Execution<E, Reason>>();
		const fork = yield* FiberSet.makeRuntime<never, void, never>();

		const loop = (key: Key, execution: Execution<E, Reason>, force: boolean): Effect.Effect<void, E> =>
			Effect.suspend(() => options.drain(key, force)).pipe(
				Effect.andThen(
					Effect.suspend(() => {
						if (execution.stopping || !execution.pendingWake) return Effect.void;
						execution.pendingWake = false;
						// Trampoline so drains that complete synchronously cannot grow the stack.
						return Effect.yieldNow.pipe(Effect.andThen(loop(key, execution, false)));
					}),
				),
			);

		const start = (key: Key, force: boolean) => {
			const execution: Execution<E, Reason> = {
				done: Deferred.makeUnsafe<void, E>(),
				pendingWake: false,
				stopping: false,
			};
			executions.set(key, execution);
			// The leading yield lets `owner` be assigned before the drain can settle and
			// trampolines successor executions after synchronous failures.
			execution.owner = fork(
				Effect.yieldNow.pipe(
					Effect.andThen(Effect.uninterruptible(options.started?.(key) ?? Effect.void)),
					Effect.andThen(loop(key, execution, force)),
					Effect.onExit((exit) =>
						Effect.sync(() => {
							delete execution.owner;
						}).pipe(Effect.andThen(options.settled?.(key, exit, execution.interruptionReason) ?? Effect.void)),
					),
					Effect.onExit((exit) => Effect.sync(() => settle(key, execution, exit))),
					Effect.exit,
					Effect.asVoid,
				),
			);
			return execution;
		};

		// A wake that survives the loop or arrives during cleanup starts a fresh busy period.
		const settle = (key: Key, execution: Execution<E, Reason>, exit: Exit.Exit<void, E>) => {
			if (execution.pendingWake) start(key, false);
			else executions.delete(key);
			Deferred.doneUnsafe(execution.done, exit);
		};

		const run = (key: Key): Effect.Effect<void, E> =>
			Effect.suspend(() => {
				const execution = executions.get(key);
				if (execution !== undefined) {
					if (execution.stopping) {
						return Deferred.await(execution.done).pipe(Effect.ignoreCause, Effect.andThen(run(key)));
					}
					return Deferred.await(execution.done);
				}
				return Deferred.await(start(key, true).done);
			});

		const wake = (key: Key) =>
			Effect.sync(() => {
				const execution = executions.get(key);
				if (execution !== undefined) {
					execution.pendingWake = true;
					return;
				}
				start(key, false);
			});

		const interrupt = (key: Key, reason?: Reason): Effect.Effect<boolean> =>
			Effect.sync(() => {
				const execution = executions.get(key);
				if (execution === undefined || execution.stopping) return false;
				if (execution.owner === undefined) {
					// The terminal exit is already decided. Claim earlier wakes so settlement
					// does not restart work for the interrupted intent.
					execution.pendingWake = false;
					return false;
				}
				execution.stopping = true;
				execution.pendingWake = false;
				if (reason !== undefined) execution.interruptionReason = reason;
				fork(Fiber.interrupt(execution.owner));
				return true;
			});

		const awaitIdle = (key: Key): Effect.Effect<void> =>
			Effect.suspend(() => {
				const execution = executions.get(key);
				if (execution === undefined) return Effect.void;
				return Deferred.await(execution.done).pipe(Effect.ignoreCause, Effect.andThen(awaitIdle(key)));
			});

		return { active: Effect.sync(() => new Set(executions.keys())), run, wake, interrupt, awaitIdle };
	});

export * as RunCoordinator from "./coordinator.ts";
