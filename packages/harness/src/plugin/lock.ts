/*
 * @file A cross-process lock on a directory.
 *
 * Kept as it was when it lived in the installer, because it works and it is the hardest piece here
 * to get right. Only its key moved: one lock per store entry, so two plugins install in parallel
 * and two installs of one plugin do not.
 *
 * Three parts:
 *
 * - **Atomic `mkdir` is the primitive.** It either creates the directory or fails with
 *   `AlreadyExists`; exactly one caller wins, with no gap between checking and creating.
 * - **The heartbeat says the holder is alive.** A crashed installer leaves its lock behind, and a
 *   waiter cannot otherwise tell a dead holder from a slow one. Staleness is measured from the
 *   last heartbeat rather than the install's start, so a slow but live install is never stolen.
 * - **The steal is the recovery**, and the bounded wait means a waiter fails with a real error
 *   instead of hanging forever.
 */

import { Duration, Effect, Option, Ref, Schedule } from "effect";
import { fileSystem as fs } from "../host.ts";

/** How long to wait for another holder before giving up. */
const TIMEOUT = Duration.minutes(2);
/** The holder refreshes the lock's mtime this often; one not refreshed for the timeout is stale. */
const HEARTBEAT = Duration.seconds(15);

const abandoned = (directory: string) =>
	Effect.gen(function* () {
		const info = yield* fs.stat(directory);
		const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
		return Option.exists(info.mtime, (mtime) => now - mtime.getTime() > Duration.toMillis(TIMEOUT));
	}).pipe(Effect.orElseSucceed(() => false));

const heartbeat = (directory: string) =>
	Effect.clockWith((clock) => clock.currentTimeMillis).pipe(
		Effect.flatMap((now) => fs.utimes(directory, now, now)),
		Effect.ignore,
		Effect.repeat(Schedule.spaced(HEARTBEAT)),
	);

/**
 * Claims `directory` by creating it, polling while another process holds it, and releasing it when
 * the surrounding scope closes.
 *
 * One finalizer is registered for the whole wait rather than one per 50ms poll, and a single
 * attempt is `uninterruptible` so `mkdir` and recording ownership cannot be split -- an interrupt
 * between them would leave behind a lock the finalizer does not know to remove.
 *
 * `onTimeout` names the failure, because what a caller is waiting for is the caller's to describe.
 */
export const lock = Effect.fn("PluginLock.acquire")(function* <E>(directory: string, onTimeout: () => E) {
	const held = yield* Ref.make(false);
	yield* Effect.acquireRelease(Effect.void, () =>
		Ref.get(held).pipe(
			Effect.flatMap((owned) => (owned ? fs.remove(directory, { recursive: true, force: true }) : Effect.void)),
			Effect.orDie,
		),
	);
	const attempt = fs.makeDirectory(directory).pipe(
		Effect.andThen(Ref.set(held, true)),
		Effect.as(true),
		Effect.catchIf(
			(error) => error.reason._tag === "AlreadyExists",
			() =>
				abandoned(directory).pipe(
					Effect.flatMap((stale) =>
						stale
							? fs.remove(directory, { recursive: true, force: true }).pipe(Effect.as(false))
							: Effect.succeed(false),
					),
				),
		),
		Effect.uninterruptible,
	);
	const acquired = yield* attempt.pipe(
		Effect.repeat({ schedule: Schedule.spaced("50 millis"), until: (owned) => owned }),
		Effect.timeoutOrElse({ duration: TIMEOUT, orElse: () => Effect.succeed(false) }),
	);
	if (!acquired) return yield* Effect.fail(onTimeout());
	// Scoped to the work: the heartbeat dies with the scope, before the lock is removed.
	yield* Effect.forkScoped(heartbeat(directory));
});

export * as PluginLock from "./lock.ts";
