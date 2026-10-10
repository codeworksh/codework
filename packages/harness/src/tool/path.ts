import { Effect } from "effect";
import type { SandboxFileSystem } from "../sandbox/fs/filesystem.ts";

/**
 * How file tools read the path a model wrote. Models copy paths out of prose and
 * terminals, so a path arrives with Unicode spaces or an `@` mention prefix the
 * file never had. Relative paths stay relative: the mount resolves them.
 */

const UNICODE_SPACES = /[  -   　]/g;
const NARROW_NO_BREAK_SPACE = " ";

/** The path a file tool acts on. */
export const normalize = (path: string): string => {
	const normalized = path.replace(UNICODE_SPACES, " ");
	return normalized.startsWith("@") ? normalized.slice(1) : normalized;
};

/**
 * The path to read: {@link normalize}d, or the first existing spelling the model
 * could not have typed — macOS screenshot names use a narrow no-break space
 * before AM/PM, decomposed (NFD) accents, and curly apostrophes. Falls back to
 * the normalized path, so a missing file is reported under the name asked for.
 */
export const resolveRead = (
	fs: SandboxFileSystem.Interface,
	path: string,
): Effect.Effect<string, SandboxFileSystem.FileSystemError> =>
	Effect.gen(function* () {
		const normalized = normalize(path);
		const variants = new Set([
			normalized,
			normalized.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
			normalized.normalize("NFD"),
			normalized.replace(/'/g, "’"),
			normalized.normalize("NFD").replace(/'/g, "’"),
		]);
		for (const variant of variants) {
			if (yield* fs.exists(variant)) return variant;
		}
		return normalized;
	});

export * as ToolPath from "./path.ts";
