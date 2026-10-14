import { Effect } from "effect";
import { SandboxFileSystem } from "../../../sandbox/fs/filesystem.ts";
import { posix } from "../../../util/posix.ts";

export const stripBom = (raw: string): string => (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);

/** `directory` and every ancestor up to the sandbox root, closest first. */
export const ancestors = (directory: string): string[] => {
	const chain: string[] = [];
	for (let current = directory; ; current = posix.dirname(current)) {
		chain.push(current);
		if (posix.dirname(current) === current) return chain;
	}
};

/**
 * Which of `paths` exist as the requested kind (`entry` takes either). Absence stays silent; any other failure
 * (permissions, a remote blip) is logged so a dropped entry is not a mystery, then counts as absent.
 */
export const present = (
	fs: SandboxFileSystem.Interface,
	paths: ReadonlyArray<string>,
	kind: "file" | "directory" | "entry",
	label: string,
) =>
	Effect.forEach(
		paths,
		(path) =>
			fs.exists(path).pipe(
				Effect.filterOrElse(
					(exists) => !exists || kind === "entry",
					() => fs.stat(path).pipe(Effect.map((stat) => (kind === "file" ? stat.isFile : stat.isDirectory))),
				),
				Effect.catch((error) =>
					SandboxFileSystem.isNotFoundError(error.cause)
						? Effect.succeed(false)
						: Effect.logWarning(`could not stat ${label} ${path}`, error.cause).pipe(Effect.as(false)),
				),
			),
		{ concurrency: "unbounded" },
	).pipe(Effect.map((hits) => new Set(paths.filter((_, index) => hits[index]))));
