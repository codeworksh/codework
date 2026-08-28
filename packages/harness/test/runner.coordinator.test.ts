import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect } from "vite-plus/test";
import { RunCoordinator } from "../src/runner/coordinator.ts";
import { it } from "./utils/effect.ts";

/**
 * The coordinator drives itself: `runner.loop.test.ts` proves a drain does its
 * work, but only ever one at a time. These tests are about the part that owns
 * *fibers* — joining concurrent callers onto one drain, coalescing wakes into a
 * single follow-up pass, and interruption — driven with Deferred gates rather than
 * clocks so nothing depends on timing.
 */

/** A drain whose every invocation is observable and individually releasable. */
const recorder = () => {
	const forces: boolean[] = [];
	const keys: string[] = [];
	return {
		forces,
		keys,
		get calls() {
			return forces.length;
		},
		/** `hold` gates the first invocation only; later ones return immediately. */
		drain: (hold?: Deferred.Deferred<void>) => (key: string, force: boolean) =>
			Effect.suspend(() => {
				const first = forces.length === 0;
				forces.push(force);
				keys.push(key);
				return first && hold !== undefined ? Deferred.await(hold) : Effect.void;
			}),
	};
};

/** Let forked fibers make progress without introducing a clock dependency. */
const settle = Effect.andThen(Effect.yieldNow, Effect.andThen(Effect.yieldNow, Effect.yieldNow));

describe("RunCoordinator", () => {
	it.effect(
		"concurrent runs for one key join a single drain",
		Effect.gen(function* () {
			const gate = yield* Deferred.make<void>();
			const started = yield* Deferred.make<void>();
			let calls = 0;

			const coordinator = yield* RunCoordinator.make<string, never>({
				drain: () =>
					Effect.suspend(() => {
						calls += 1;
						return Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(gate)));
					}),
			});

			const first = yield* Effect.forkChild(coordinator.run("session"));
			yield* Deferred.await(started);
			const second = yield* Effect.forkChild(coordinator.run("session"));
			yield* settle;

			// The second caller attached to the drain already in flight.
			expect(calls).toBe(1);

			yield* Deferred.succeed(gate, undefined);
			yield* Fiber.join(first);
			yield* Fiber.join(second);

			// And joining did not queue a second pass on the way out.
			expect(calls).toBe(1);
		}),
	);

	it.effect(
		"run forces a pass; wake does not",
		Effect.gen(function* () {
			const record = recorder();
			const coordinator = yield* RunCoordinator.make<string, never>({ drain: record.drain() });

			yield* coordinator.run("session");
			yield* coordinator.wake("session");
			yield* coordinator.awaitIdle("session");

			expect(record.forces).toEqual([true, false]);
		}),
	);

	it.effect(
		"awaitIdle returns immediately while idle without starting work",
		Effect.gen(function* () {
			const record = recorder();
			const coordinator = yield* RunCoordinator.make<string, never>({ drain: record.drain() });

			yield* coordinator.awaitIdle("session");

			expect(record.calls).toBe(0);
			expect(Array.from(yield* coordinator.active)).toEqual([]);
		}),
	);

	it.effect(
		"wake followed by awaitIdle drains without forcing an empty pass",
		Effect.gen(function* () {
			const gate = yield* Deferred.make<void>();
			const started = yield* Deferred.make<void>();
			const forces: boolean[] = [];
			const coordinator = yield* RunCoordinator.make<string, never>({
				drain: (_key, force) =>
					Effect.sync(() => forces.push(force)).pipe(
						Effect.andThen(Deferred.succeed(started, undefined)),
						Effect.andThen(Deferred.await(gate)),
					),
			});

			yield* coordinator.wake("session");
			const idle = yield* Effect.forkChild(coordinator.awaitIdle("session"));
			yield* Deferred.await(started);
			expect(forces).toEqual([false]);
			expect(idle.pollUnsafe()).toBeUndefined();

			yield* Deferred.succeed(gate, undefined);
			yield* Fiber.join(idle);
		}),
	);

	it.effect(
		"awaitIdle follows coalesced work until the key is idle",
		Effect.gen(function* () {
			const firstStarted = yield* Deferred.make<void>();
			const firstGate = yield* Deferred.make<void>();
			const secondStarted = yield* Deferred.make<void>();
			const secondGate = yield* Deferred.make<void>();
			const forces: boolean[] = [];
			const coordinator = yield* RunCoordinator.make<string, never>({
				drain: (_key, force) =>
					Effect.suspend(() => {
						forces.push(force);
						return forces.length === 1
							? Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(firstGate)))
							: Deferred.succeed(secondStarted, undefined).pipe(Effect.andThen(Deferred.await(secondGate)));
					}),
			});

			const running = yield* Effect.forkChild(coordinator.run("session"));
			yield* Deferred.await(firstStarted);
			yield* coordinator.wake("session");
			const idle = yield* Effect.forkChild(coordinator.awaitIdle("session"));
			yield* Deferred.succeed(firstGate, undefined);
			yield* Deferred.await(secondStarted);
			expect(running.pollUnsafe()).toBeUndefined();
			expect(idle.pollUnsafe()).toBeUndefined();

			yield* Deferred.succeed(secondGate, undefined);
			yield* Fiber.join(running);
			yield* Fiber.join(idle);
			expect(forces).toEqual([true, false]);
		}),
	);

	it.effect(
		"a wake during an active drain runs exactly one follow-up pass, unforced",
		Effect.gen(function* () {
			const gate = yield* Deferred.make<void>();
			const started = yield* Deferred.make<void>();
			const forces: boolean[] = [];

			const coordinator = yield* RunCoordinator.make<string, never>({
				drain: (_key, force) =>
					Effect.suspend(() => {
						const first = forces.length === 0;
						forces.push(force);
						return first
							? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(gate)))
							: Effect.void;
					}),
			});

			const fiber = yield* Effect.forkChild(coordinator.run("session"));
			yield* Deferred.await(started);
			yield* coordinator.wake("session");
			yield* Deferred.succeed(gate, undefined);
			yield* Fiber.join(fiber);
			yield* settle;

			// New work arrived mid-drain, so a second pass runs — and the caller of
			// `run` stays joined until that successor finishes.
			expect(forces).toEqual([true, false]);
		}),
	);

	it.effect(
		"repeated wakes during one drain coalesce into a single successor",
		Effect.gen(function* () {
			const gate = yield* Deferred.make<void>();
			const started = yield* Deferred.make<void>();
			const forces: boolean[] = [];

			const coordinator = yield* RunCoordinator.make<string, never>({
				drain: (_key, force) =>
					Effect.suspend(() => {
						const first = forces.length === 0;
						forces.push(force);
						return first
							? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(gate)))
							: Effect.void;
					}),
			});

			const fiber = yield* Effect.forkChild(coordinator.run("session"));
			yield* Deferred.await(started);
			yield* coordinator.wake("session");
			yield* coordinator.wake("session");
			yield* coordinator.wake("session");
			yield* Deferred.succeed(gate, undefined);
			yield* Fiber.join(fiber);
			yield* settle;

			// `pendingWake` is a flag, not a counter: three wakes are one follow-up pass.
			expect(forces).toEqual([true, false]);
		}),
	);

	it.effect(
		"lifecycle hooks run once across coalesced drains in one busy period",
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>();
			const gate = yield* Deferred.make<void>();
			let drains = 0;
			let starts = 0;
			const exits: Exit.Exit<void, never>[] = [];
			const coordinator = yield* RunCoordinator.make<string, never>({
				drain: () => {
					drains += 1;
					return drains === 1
						? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(gate)))
						: Effect.void;
				},
				started: () => Effect.sync(() => void starts++),
				settled: (_key, exit) => Effect.sync(() => void exits.push(exit)),
			});

			yield* coordinator.wake("session");
			yield* Deferred.await(started);
			yield* coordinator.wake("session");
			yield* Deferred.succeed(gate, undefined);
			yield* coordinator.awaitIdle("session");

			expect(drains).toBe(2);
			expect(starts).toBe(1);
			expect(exits).toHaveLength(1);
			expect(Exit.isSuccess(exits[0]!)).toBe(true);
		}),
	);

	it.effect(
		"different keys drain concurrently and `active` snapshots only in-flight ones",
		Effect.gen(function* () {
			const firstStarted = yield* Deferred.make<void>();
			const secondStarted = yield* Deferred.make<void>();
			const firstGate = yield* Deferred.make<void>();
			const secondGate = yield* Deferred.make<void>();

			const coordinator = yield* RunCoordinator.make<string, never>({
				drain: (key) =>
					key === "a"
						? Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(firstGate)))
						: Deferred.succeed(secondStarted, undefined).pipe(Effect.andThen(Deferred.await(secondGate))),
			});

			expect(Array.from(yield* coordinator.active)).toEqual([]);

			const a = yield* Effect.forkChild(coordinator.run("a"));
			yield* Deferred.await(firstStarted);
			expect(Array.from(yield* coordinator.active)).toEqual(["a"]);

			// "a" is still blocked, so this proves the lanes are independent.
			const b = yield* Effect.forkChild(coordinator.run("b"));
			yield* Deferred.await(secondStarted);
			expect(Array.from(yield* coordinator.active).sort()).toEqual(["a", "b"]);

			yield* Deferred.succeed(firstGate, undefined);
			yield* Fiber.join(a);
			expect(Array.from(yield* coordinator.active)).toEqual(["b"]);

			yield* Deferred.succeed(secondGate, undefined);
			yield* Fiber.join(b);
			expect(Array.from(yield* coordinator.active)).toEqual([]);
		}),
	);

	it.effect(
		"interrupting an idle key is a no-op",
		Effect.gen(function* () {
			const record = recorder();
			const coordinator = yield* RunCoordinator.make<string, never>({ drain: record.drain() });

			expect(yield* coordinator.interrupt("never-started")).toBe(false);
			yield* settle;

			expect(record.calls).toBe(0);
			expect(Array.from(yield* coordinator.active)).toEqual([]);
		}),
	);

	it.effect(
		"interrupting an active drain stops it and cancels a pending wake",
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>();
			const never = yield* Deferred.make<void>();
			let calls = 0;

			const coordinator = yield* RunCoordinator.make<string, never>({
				drain: () =>
					Effect.suspend(() => {
						calls += 1;
						return Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(never)));
					}),
			});

			const fiber = yield* Effect.forkChild(coordinator.run("session"));
			yield* Deferred.await(started);
			yield* coordinator.wake("session"); // queue a follow-up...
			expect(yield* coordinator.interrupt("session")).toBe(true); // ...which the interrupt discards
			yield* Fiber.join(fiber).pipe(Effect.exit);
			yield* coordinator.awaitIdle("session");

			// Interruption is a stop, not a restart: no successor runs.
			expect(calls).toBe(1);
			expect(Array.from(yield* coordinator.active)).toEqual([]);
		}),
	);

	it.effect(
		"a drain failure reaches every joined caller",
		Effect.gen(function* () {
			const gate = yield* Deferred.make<void>();
			const started = yield* Deferred.make<void>();
			const failure = new Error("drain failed");

			const coordinator = yield* RunCoordinator.make<string, Error>({
				drain: () =>
					Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Deferred.await(gate)),
						Effect.andThen(Effect.fail(failure)),
					),
			});

			const first = yield* Effect.forkChild(coordinator.run("session"));
			yield* Deferred.await(started);
			const second = yield* Effect.forkChild(coordinator.run("session"));
			yield* settle;

			yield* Deferred.succeed(gate, undefined);
			const firstExit = yield* Fiber.join(first).pipe(Effect.exit);
			const secondExit = yield* Fiber.join(second).pipe(Effect.exit);

			// A joiner must not silently observe success for work that failed.
			expect(Exit.isFailure(firstExit)).toBe(true);
			expect(Exit.isFailure(secondExit)).toBe(true);
			expect(Array.from(yield* coordinator.active)).toEqual([]);
		}),
	);

	it.effect(
		"awaitIdle ignores drain failure and resolves once ownership clears",
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>();
			const gate = yield* Deferred.make<void>();
			const failure = new Error("drain failed");
			const coordinator = yield* RunCoordinator.make<string, Error>({
				drain: () =>
					Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Deferred.await(gate)),
						Effect.andThen(Effect.fail(failure)),
					),
			});

			yield* coordinator.wake("session");
			yield* Deferred.await(started);
			const idle = yield* Effect.forkChild(coordinator.awaitIdle("session"));
			yield* Deferred.succeed(gate, undefined);
			yield* Fiber.join(idle);

			expect(Array.from(yield* coordinator.active)).toEqual([]);
		}),
	);

	it.effect(
		"a run requested during a stop waits for it, then drains fresh",
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>();
			const never = yield* Deferred.make<void>();
			const forces: boolean[] = [];

			const coordinator = yield* RunCoordinator.make<string, never>({
				drain: (_key, force) =>
					Effect.suspend(() => {
						const first = forces.length === 0;
						forces.push(force);
						return first
							? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(never)))
							: Effect.void;
					}),
			});

			const running = yield* Effect.forkChild(coordinator.run("session"));
			yield* Deferred.await(started);

			// Ask to stop, then immediately ask to run again.
			expect(yield* coordinator.interrupt("session")).toBe(true);
			const resumed = yield* Effect.forkChild(coordinator.run("session"));

			yield* Fiber.join(running).pipe(Effect.exit);
			yield* Fiber.join(resumed);

			// The second request is not swallowed by the stop, and it forces.
			expect(forces).toEqual([true, true]);
			expect(Array.from(yield* coordinator.active)).toEqual([]);
		}),
	);

	// A caller waiting on someone else's drain is a bystander. Interrupting it
	// must not reach through the join and kill work another caller is depending
	// on — the drain runs in the coordinator's own fiber, not the waiter's.
	it.effect(
		"interrupting a joined waiter does not cancel the drain",
		Effect.gen(function* () {
			const gate = yield* Deferred.make<void>();
			const started = yield* Deferred.make<void>();
			let calls = 0;

			const coordinator = yield* RunCoordinator.make<string, never>({
				drain: () =>
					Effect.suspend(() => {
						calls += 1;
						return Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(gate)));
					}),
			});

			const first = yield* Effect.forkChild(coordinator.run("session"));
			yield* Deferred.await(started);
			const second = yield* Effect.forkChild(coordinator.run("session"));
			yield* settle;
			yield* Fiber.interrupt(second);

			yield* Deferred.succeed(gate, undefined);
			yield* Fiber.join(first);

			expect(calls).toBe(1);
			expect(Array.from(yield* coordinator.active)).toEqual([]);
		}),
	);

	it.effect(
		"active clears after a failure and after a defect",
		Effect.gen(function* () {
			const coordinator = yield* RunCoordinator.make<string, Error>({
				drain: (key) => (key === "fails" ? Effect.fail(new Error("failed")) : Effect.die(new Error("defect"))),
			});

			const failed = yield* coordinator.run("fails").pipe(Effect.exit);
			expect(Exit.isFailure(failed) && Cause.hasFails(failed.cause)).toBe(true);
			expect(Array.from(yield* coordinator.active)).toEqual([]);

			// A defect must clean up as thoroughly as a typed failure, or a crashed
			// drain would strand its key as permanently busy.
			const died = yield* coordinator.run("dies").pipe(Effect.exit);
			expect(Exit.isFailure(died) && Cause.hasDies(died.cause)).toBe(true);
			expect(Array.from(yield* coordinator.active)).toEqual([]);
		}),
	);

	it.effect(
		"closing the coordinator's scope clears its active work",
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>();

			const coordinator = yield* Effect.scoped(
				Effect.gen(function* () {
					const coordinator = yield* RunCoordinator.make<string, never>({
						drain: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
					});
					yield* coordinator.wake("session");
					yield* Deferred.await(started);
					expect(Array.from(yield* coordinator.active)).toEqual(["session"]);
					return coordinator;
				}),
			);

			// Process shutdown must not leave a drain running or a key claimed.
			expect(Array.from(yield* coordinator.active)).toEqual([]);
		}),
	);

	// The window between `interrupt` and the drain's finalizers completing is
	// still a live window: work admitted there has to survive it.
	it.effect(
		"a wake arriving during interruption cleanup runs a successor",
		Effect.gen(function* () {
			const firstStarted = yield* Deferred.make<void>();
			const cleanupStarted = yield* Deferred.make<void>();
			const cleanupGate = yield* Deferred.make<void>();
			const secondStarted = yield* Deferred.make<void>();
			let calls = 0;

			const coordinator = yield* RunCoordinator.make<string, never>({
				drain: () =>
					Effect.suspend(() => {
						calls += 1;
						return calls === 1
							? Deferred.succeed(firstStarted, undefined).pipe(
									Effect.andThen(Effect.never),
									Effect.onInterrupt(() =>
										Deferred.succeed(cleanupStarted, undefined).pipe(
											Effect.andThen(Deferred.await(cleanupGate)),
										),
									),
								)
							: Deferred.succeed(secondStarted, undefined).pipe(Effect.asVoid);
					}),
			});

			yield* coordinator.wake("session");
			yield* Deferred.await(firstStarted);
			expect(yield* coordinator.interrupt("session")).toBe(true);
			yield* Deferred.await(cleanupStarted);
			yield* coordinator.wake("session"); // admitted mid-cleanup
			yield* Deferred.succeed(cleanupGate, undefined);
			yield* Deferred.await(secondStarted);
			yield* coordinator.awaitIdle("session");

			expect(calls).toBe(2);
		}),
	);

	it.effect(
		"interrupt acknowledges before cleanup while awaitIdle waits for settlement",
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>();
			const cleanupStarted = yield* Deferred.make<void>();
			const cleanupGate = yield* Deferred.make<void>();
			const reasons: Array<string | undefined> = [];
			const coordinator = yield* RunCoordinator.make<string, never, string>({
				drain: () =>
					Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Effect.never),
						Effect.onInterrupt(() =>
							Deferred.succeed(cleanupStarted, undefined).pipe(Effect.andThen(Deferred.await(cleanupGate))),
						),
					),
				settled: (_key, _exit, reason) => Effect.sync(() => void reasons.push(reason)),
			});

			yield* coordinator.wake("session");
			yield* Deferred.await(started);
			expect(yield* coordinator.interrupt("session", "user")).toBe(true);
			expect(yield* coordinator.interrupt("session", "user")).toBe(false);
			expect(reasons).toEqual([]);
			expect(Array.from(yield* coordinator.active)).toEqual(["session"]);

			yield* Deferred.await(cleanupStarted);
			const idle = yield* Effect.forkChild(coordinator.awaitIdle("session"));
			yield* settle;
			expect(idle.pollUnsafe()).toBeUndefined();
			yield* Deferred.succeed(cleanupGate, undefined);
			yield* Fiber.join(idle);

			expect(reasons).toEqual(["user"]);
			expect(Array.from(yield* coordinator.active)).toEqual([]);
		}),
	);

	it.effect(
		"an interrupt during terminal settlement claims an earlier wake",
		Effect.gen(function* () {
			const settling = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			let drains = 0;
			const coordinator = yield* RunCoordinator.make<string, never>({
				drain: () => Effect.sync(() => void drains++),
				settled: () => Deferred.succeed(settling, undefined).pipe(Effect.andThen(Deferred.await(release))),
			});

			yield* coordinator.wake("session");
			yield* Deferred.await(settling);
			yield* coordinator.wake("session");
			expect(yield* coordinator.interrupt("session")).toBe(false);
			yield* Deferred.succeed(release, undefined);
			yield* coordinator.awaitIdle("session");

			expect(drains).toBe(1);
			expect(Array.from(yield* coordinator.active)).toEqual([]);
		}),
	);

	it.effect(
		"a wake racing with a failure starts exactly one follow-up",
		Effect.gen(function* () {
			const gate = yield* Deferred.make<void>();
			const started = yield* Deferred.make<void>();
			const secondStarted = yield* Deferred.make<void>();
			const failure = new Error("failed");
			let calls = 0;

			const coordinator = yield* RunCoordinator.make<string, Error>({
				drain: () =>
					Effect.suspend(() => {
						calls += 1;
						return calls === 1
							? Deferred.succeed(started, undefined).pipe(
									Effect.andThen(Deferred.await(gate)),
									Effect.andThen(Effect.fail(failure)),
								)
							: Deferred.succeed(secondStarted, undefined).pipe(Effect.asVoid);
					}),
			});

			const resumed = yield* Effect.forkChild(coordinator.run("session"));
			yield* Deferred.await(started);
			yield* coordinator.wake("session");
			const idle = yield* Effect.forkChild(coordinator.awaitIdle("session"));
			yield* Deferred.succeed(gate, undefined);

			// The failure reaches the caller, and the queued work still runs — once.
			expect(Exit.isFailure(yield* Fiber.join(resumed).pipe(Effect.exit))).toBe(true);
			yield* Deferred.await(secondStarted);
			yield* Fiber.join(idle);
			expect(calls).toBe(2);
		}),
	);

	it.effect(
		"a wake during the follow-up runs the drain again",
		Effect.gen(function* () {
			const firstGate = yield* Deferred.make<void>();
			const firstStarted = yield* Deferred.make<void>();
			const secondStarted = yield* Deferred.make<void>();
			const secondGate = yield* Deferred.make<void>();
			let calls = 0;

			const coordinator = yield* RunCoordinator.make<string, never>({
				drain: () =>
					Effect.suspend(() => {
						calls += 1;
						if (calls === 1) {
							return Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(firstGate)));
						}
						if (calls === 2) {
							return Deferred.succeed(secondStarted, undefined).pipe(Effect.andThen(Deferred.await(secondGate)));
						}
						return Effect.void;
					}),
			});

			const fiber = yield* Effect.forkChild(coordinator.run("session"));
			yield* Deferred.await(firstStarted);
			yield* coordinator.wake("session");
			yield* Deferred.succeed(firstGate, undefined);

			yield* Deferred.await(secondStarted);
			yield* coordinator.wake("session"); // arrives during the follow-up
			yield* Deferred.succeed(secondGate, undefined);
			yield* Fiber.join(fiber);
			yield* coordinator.awaitIdle("session");

			expect(calls).toBe(3);
		}),
	);

	// A drain that wakes its own key must recur through the scheduler, not the
	// stack: `settle` starting a successor synchronously would grow the stack once
	// per pass and eventually overflow.
	it.effect(
		"synchronous self-waking is trampolined rather than recursed",
		Effect.gen(function* () {
			const limit = 10_000;
			const completed = yield* Deferred.make<void>();
			let calls = 0;
			let wake: (key: string) => Effect.Effect<void> = () => Effect.void;

			const coordinator = yield* RunCoordinator.make<string, never>({
				drain: (key) =>
					Effect.suspend(() => {
						calls += 1;
						return calls < limit ? wake(key) : Deferred.succeed(completed, undefined).pipe(Effect.asVoid);
					}),
			});
			wake = coordinator.wake;

			yield* coordinator.wake("session");
			yield* Deferred.await(completed);
			yield* coordinator.awaitIdle("session");

			expect(calls).toBe(limit);
		}),
	);
});
