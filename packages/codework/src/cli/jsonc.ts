import { SettingsFile } from "@codeworksh/harness/effect";
import { Effect, FileSystem } from "effect";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { InvalidInputError } from "./error.ts";

/**
 * Reading and rewriting one value of a JSONC file the CLI edits for its owner: `settings.jsonc`,
 * `mcp.json`. The edit and the write are the harness's {@link SettingsFile}, shared with the app
 * server.
 */

/** The file's text and its top-level object; a missing file reads as `{}`. */
export const read = Effect.fn("CLI.jsonc.read")(function* (path: string, what: string) {
	const fs = yield* FileSystem.FileSystem;
	const source = (yield* fs.exists(path)) ? yield* fs.readFileString(path) : "{}";
	const errors: ParseError[] = [];
	const document: unknown = parseJsonc(source, errors, { allowTrailingComma: true });
	if (errors.length > 0 || typeof document !== "object" || document === null || Array.isArray(document)) {
		return yield* new InvalidInputError({ message: `${path} is not a valid ${what}` });
	}
	return { source, document: document as Record<string, unknown> };
});

/** Set the value at `at` in `source`, or remove it when `value` is undefined, and write the file. */
export const write = (path: string, source: string, at: ReadonlyArray<string>, value: unknown) =>
	SettingsFile.save(path, SettingsFile.edit(source, at, value));

/**
 * Serialize one read-modify-rename of `path` across CLI processes and the app server. Only the local
 * edit is locked, so work that precedes it does not wait behind another process.
 */
export const locked = <A, E, R>(path: string, edit: Effect.Effect<A, E, R>) =>
	SettingsFile.locked(path, () => new InvalidInputError({ message: `timed out waiting to edit ${path}` }), edit);
