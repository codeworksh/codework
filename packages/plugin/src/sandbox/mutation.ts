import { Context, Deferred, Effect } from "effect";
import { posix } from "../posix.ts";
import { type FileSystemError, type Interface as FileSystem, isNotFoundError } from "./filesystem.ts";
import type { SandboxInstance } from "./instance.ts";

/**
 * Serializes mutations of one file.
 *
 * Tool calls may run in parallel, and a file-mutating tool does read → modify →
 * write. Two of those on one file interleave and the first write is lost, so a
 * tool holds the file for its whole read-modify-write.
 *
 * A file is its sandbox instance plus its canonical path: two mounts of one
 * instance share files, and a symlinked spelling of a path is the same file.
 * Other files never wait. This orders the harness's own tools within this
 * process only; it is not a lock against `bash` or other processes.
 */
export interface Interface {
	/**
	 * Run `effect` as the only mutation of `path` in flight. Calls queue in the
	 * order their paths resolve, which for one spelling is the order they were made.
	 */
	readonly withFile: <A, E, R>(
		path: string,
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | FileSystemError, R>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/plugin/sandbox/mutation/Service") {}

interface Lock {
	readonly waiters: Array<Deferred.Deferred<void>>;
}

// Process-wide on purpose: every mount of one instance must meet in the same
// queue, whichever layer built it. A key is present exactly while its file is held.
const locks = new Map<string, Lock>();

/** Hand the file to the next waiter, or free it. Ownership moves directly, so no newcomer can barge in. */
const release = (key: string, lock: Lock): void => {
	const next = lock.waiters.shift();
	if (next === undefined) locks.delete(key);
	else Deferred.doneUnsafe(next, Effect.void);
};

/** Take the file, waiting interruptibly; must run uninterruptibly so taking and releasing pair up. */
const acquire = (key: string, restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>) =>
	Effect.suspend(() => {
		const lock = locks.get(key);
		if (lock === undefined) {
			locks.set(key, { waiters: [] });
			return Effect.void;
		}
		const turn = Deferred.makeUnsafe<void>();
		lock.waiters.push(turn);
		return restore(Deferred.await(turn)).pipe(
			Effect.onInterrupt(() =>
				Effect.sync(() => {
					const index = lock.waiters.indexOf(turn);
					// Still queued: leave. Already handed the file: pass it on.
					if (index !== -1) lock.waiters.splice(index, 1);
					else release(key, lock);
				}),
			),
		);
	});

/**
 * The canonical path. A file that does not exist yet takes its canonical
 * parent joined with its name, walking up as far as needed, so a write that
 * creates a file (and its directories) shares a key with later mutations of it.
 */
const canonical = (fs: FileSystem, path: string): Effect.Effect<string, FileSystemError> =>
	fs.realpath(path).pipe(
		Effect.catchIf(
			(error) => isNotFoundError(error.cause),
			(error) => {
				const parent = posix.dirname(path);
				if (parent === path) return Effect.fail(error);
				return Effect.map(canonical(fs, parent), (resolved) => posix.join(resolved, posix.basename(path)));
			},
		),
	);

export const make = (instance: SandboxInstance.ID, cwd: string, fs: FileSystem): Interface => ({
	withFile: (path, effect) =>
		Effect.flatMap(canonical(fs, posix.resolve(cwd, path)), (resolved) => {
			const key = `${instance}\0${resolved}`;
			// Held from the moment `acquire` returns: nothing can interrupt between
			// taking the file and installing its release.
			return Effect.uninterruptibleMask((restore) =>
				Effect.andThen(
					acquire(key, restore),
					restore(effect).pipe(
						Effect.ensuring(
							Effect.sync(() => {
								const lock = locks.get(key);
								if (lock !== undefined) release(key, lock);
							}),
						),
					),
				),
			);
		}),
});

export * as SandboxMutation from "./mutation.ts";
