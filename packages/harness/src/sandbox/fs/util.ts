import { Effect } from "effect";
import { posix } from "node:path";
import type { SandboxFileSystem } from "./filesystem.ts";

/**
 * Operations derived from the {@link SandboxFileSystem.Interface} primitives.
 *
 * These take the filesystem as an argument rather than living on the service,
 * so every backend — VFS, in-memory, Daytona, Vercel — gets one implementation
 * and none can report them as unsupported. A backend method belongs in the
 * service only when it cannot be expressed in terms of the others.
 *
 * Paths are POSIX, matching the rest of `sandbox/`.
 */

/**
 * Best-effort existence check: a backend that cannot answer reports `false`.
 * Only for callers where an unreliable answer is acceptable — never for one
 * that deletes or overwrites on the strength of an absent result.
 */
export const existsOrFalse = (fs: SandboxFileSystem.Interface, path: string) =>
	fs.exists(path).pipe(Effect.orElseSucceed(() => false));

/**
 * Walk from `start` towards the root, collecting every `targets` entry that
 * exists along the way. Stops after `stop` when given, otherwise at the root.
 * Results are ordered nearest-first, so `[0]` is the closest match.
 *
 * A probe that fails is treated as a miss and the walk continues: searching is
 * inherently best-effort, and one unreadable directory should not abort it.
 */
export const up = Effect.fn("SandboxFileSystem.up")(function* (
	fs: SandboxFileSystem.Interface,
	options: { readonly targets: ReadonlyArray<string>; readonly start: string; readonly stop?: string },
) {
	const found: string[] = [];
	let current = posix.normalize(options.start);
	const stop = options.stop === undefined ? undefined : posix.normalize(options.stop);

	while (true) {
		for (const target of options.targets) {
			const candidate = posix.join(current, target);
			if (yield* existsOrFalse(fs, candidate)) found.push(candidate);
		}

		if (stop === current) break;

		const parent = posix.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return found;
});

/** True when `path` exists and is a directory; false when it is absent or unreadable. */
export const isDirectory = Effect.fn("SandboxFileSystem.isDirectory")(function* (
	fs: SandboxFileSystem.Interface,
	path: string,
) {
	return yield* fs.stat(path).pipe(
		Effect.map((stat) => stat.isDirectory),
		Effect.orElseSucceed(() => false),
	);
});

/** True when `path` exists and is a regular file; false when it is absent or unreadable. */
export const isFile = Effect.fn("SandboxFileSystem.isFile")(function* (fs: SandboxFileSystem.Interface, path: string) {
	return yield* fs.stat(path).pipe(
		Effect.map((stat) => stat.isFile),
		Effect.orElseSucceed(() => false),
	);
});

/** Read a file, or `undefined` when it is missing or unreadable. */
export const readFileSafe = Effect.fn("SandboxFileSystem.readFileSafe")(function* (
	fs: SandboxFileSystem.Interface,
	path: string,
) {
	return yield* fs.readFile(path).pipe(Effect.orElseSucceed(() => undefined));
});

export * as SandboxFs from "./util.ts";
