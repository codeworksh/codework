/*
 * @file Coordinator provides the execution process manager (fibers).
 * Handles process concurrency and coordination for the provided drain function.
 * */
import { Deferred, Effect, Exit, Fiber, FiberSet, Scope } from "effect";

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E> {
	/** Snapshots keys with an execution owned by this coordinator. */
	readonly active: Effect.Effect<ReadonlySet<Key>>;
	/** Starts execution while idle or joins the active execution. */
	readonly run: (key: Key) => Effect.Effect<void, E>;
	/** Registers one coalesced follow-up after newly recorded work. */
	readonly wake: (key: Key) => Effect.Effect<void>;
	/** Stops active execution and waits for its cleanup. */
	readonly interrupt: (key: Key) => Effect.Effect<void>;
}

type Entry<E> = {
	// other fiber wants to know when key is finished will await this deferred
	readonly done: Deferred.Deferred<void, E>;
	// process owner
	owner?: Fiber.Fiber<void, never>;
	// if called wake() while the fiber is running, flips to true
	// runs one more time when finished.
	pendingWake: boolean;
	// set by interrupt()
	stopping: boolean;
};

export const make = <Key, E>(options: {
	// Actual work that is to be run within the coordinator
	// key: Execution resource ID e.g: sessionID
	// force: A boolean flag passed down by coordinator
	readonly drain: (key: Key, force: boolean) => Effect.Effect<void, E>;
}): Effect.Effect<Coordinator<Key, E>, never, Scope.Scope> =>
	Effect.gen(function* () {
		const active = new Map<Key, Entry<E>>();
		const fork = yield* FiberSet.makeRuntime<never, void, never>();

		const makeEntry = (): Entry<E> => ({
			done: Deferred.makeUnsafe<void, E>(),
			pendingWake: false,
			stopping: false,
		});

		const start = (key: Key, entry: Entry<E>, force: boolean, successor = false) => {
			// The Race Condition:
			// When we spawn new fiber, Effect fork might start immediate execution on same tick of event loop
			// `entry.owner` might not be set i.e `settle` is invoked before setting `entry.owner`, leading to race conditions
			// To prevent this, parent creates Deferred called ready.
			// The child fiber sees:  `Deferred.await(ready)` and sleeps giving time for parent to set the `entry.owner = owner`
			// Once assigned, the parent calls `Deferred.doneUnsafe` waking the child up for actual work.
			//
			// In Successor Path:
			// If the fiber was spawned by settle because pendingWake was set true, it doesn't need the ready lock.
			// As the parent of settle, already knows about the entry exists and has set `entry.owner`
			const ready = Deferred.makeUnsafe<void>();
			const owner = fork(
				(successor ? Effect.yieldNow : Deferred.await(ready)).pipe(
					Effect.andThen(Effect.suspend(() => options.drain(key, force))),
					Effect.onExit((exit) => Effect.sync(() => settle(key, entry, exit))),
					Effect.exit,
					Effect.asVoid,
				),
			);
			entry.owner = owner;
			if (!successor) Deferred.doneUnsafe(ready, Effect.void);
		};

		const settle = (key: Key, entry: Entry<E>, exit: Exit.Exit<void, E>) => {
			if (Exit.isSuccess(exit) && !entry.stopping && entry.pendingWake) {
				entry.pendingWake = false;
				start(key, entry, false, true);
				return;
			}

			const successor = entry.pendingWake ? makeEntry() : undefined;
			if (successor === undefined) active.delete(key);
			else {
				active.set(key, successor);
				start(key, successor, false, true);
			}
			Deferred.doneUnsafe(entry.done, exit);
		};

		const run = (key: Key): Effect.Effect<void, E> =>
			Effect.uninterruptibleMask((restore) => {
				const entry = active.get(key);
				if (entry !== undefined) {
					if (entry.stopping) return restore(Deferred.await(entry.done).pipe(Effect.andThen(run(key))));
					return restore(Deferred.await(entry.done));
				}

				const next = makeEntry();
				active.set(key, next);
				start(key, next, true);
				return restore(Deferred.await(next.done));
			});

		const wake = (key: Key) =>
			Effect.sync(() => {
				const entry = active.get(key);
				if (entry !== undefined) {
					entry.pendingWake = true;
					return;
				}

				const next = makeEntry();
				active.set(key, next);
				start(key, next, false);
			});

		const interrupt = (key: Key): Effect.Effect<void> =>
			Effect.suspend(() => {
				const entry = active.get(key);
				if (entry?.owner === undefined) return Effect.void;
				entry.stopping = true;
				entry.pendingWake = false;
				return Fiber.interrupt(entry.owner);
			});

		return { active: Effect.sync(() => new Set(active.keys())), run, wake, interrupt };
	});

export * as RunCoordinator from "./coordinator";
