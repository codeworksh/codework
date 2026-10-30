/**
 * A cross-process lock held for the calling scope, on `proper-lockfile`.
 *
 * The lock is a directory created with an atomic `mkdir`; exactly one process wins. The holder
 * keeps touching its mtime, so a lock left by a killed process goes stale and the next waiter
 * takes it over, while a slow but live holder is never stolen from. A waiter polls until `wait`
 * runs out, and an interrupted waiter stops polling at once.
 */

import lockfile from "proper-lockfile";
import { Data, Duration, Effect, Schedule, Schema } from "effect";
import { fileSystem, hostPath } from "../host.ts";

export interface Options {
	/** A lock whose holder stopped renewing it for this long is taken over. */
	readonly stale: Duration.Input;
	/** How long to wait for another holder before failing with `onTimeout`. */
	readonly wait: Duration.Input;
}

/** The lock directory could not be created for a reason other than another holder. */
export class LockError extends Schema.TaggedError<LockError>()("LockError", {
	path: Schema.String,
	message: Schema.String,
}) {}

/** Another process holds the lock. */
class Held extends Data.TaggedError("Lock.Held") {}

const POLL = Duration.millis(50);

/**
 * Claims the lock directory `path`, releasing it when the surrounding scope closes. `onTimeout`
 * names the failure, because what a caller waits for is the caller's to describe.
 */
export const acquire = Effect.fn("Lock.acquire")(function* <E>(path: string, options: Options, onTimeout: () => E) {
	yield* fileSystem.makeDirectory(hostPath.dirname(path), { recursive: true }).pipe(Effect.ignore);
	let release: (() => Promise<void>) | undefined;
	yield* Effect.addFinalizer(() =>
		release === undefined ? Effect.void : Effect.promise(() => release!().catch(() => undefined)),
	);
	// One attempt is uninterruptible, so a lock taken is always recorded for the finalizer above.
	const attempt = Effect.tryPromise({
		try: () =>
			lockfile.lock(path, {
				lockfilePath: path,
				realpath: false,
				stale: Duration.toMillis(options.stale),
				retries: 0,
				// The default throws from a timer. A lost lock at worst lets two holders overlap.
				onCompromised: () => {},
			}),
		catch: (error) =>
			(error as { readonly code?: unknown }).code === "ELOCKED"
				? new Held()
				: new LockError({ path, message: error instanceof Error ? error.message : String(error) }),
	}).pipe(
		Effect.map((done) => {
			release = done;
			return true;
		}),
		Effect.catchTag("Lock.Held", () => Effect.succeed(false)),
		Effect.uninterruptible,
	);
	const acquired = yield* attempt.pipe(
		Effect.repeat({ schedule: Schedule.spaced(POLL), until: (owned) => owned }),
		Effect.timeoutOrElse({ duration: options.wait, orElse: () => Effect.succeed(false) }),
	);
	if (!acquired) return yield* Effect.fail(onTimeout());
});

export * as Lock from "./lock.ts";
