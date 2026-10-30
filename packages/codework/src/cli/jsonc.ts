import { Plugin } from "@codeworksh/harness/effect";
import { Effect, FileSystem, Path } from "effect";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import { InvalidInputError } from "./error.ts";

/**
 * Reading and rewriting one value of a JSONC file the CLI edits for its owner: `settings.jsonc`,
 * `mcp.json`.
 *
 * Edits go through `jsonc-parser`, so a hand-written file keeps its comments, key order and
 * formatting. The write is a temp file renamed over the original, so an interrupted run leaves the
 * previous file intact rather than a half-written document.
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
export const write = Effect.fn("CLI.jsonc.write")(function* (
	path: string,
	source: string,
	at: ReadonlyArray<string>,
	value: unknown,
) {
	const fs = yield* FileSystem.FileSystem;
	const nodePath = yield* Path.Path;
	// A removal is not formatted: the formatter would reflow the sibling before it as well.
	const edited = applyEdits(
		source,
		modify(
			source,
			[...at],
			value,
			value === undefined ? {} : { formattingOptions: { tabSize: 2, insertSpaces: false } },
		),
	);
	const directory = nodePath.dirname(path);
	yield* fs.makeDirectory(directory, { recursive: true });
	const mode = (yield* fs.exists(path)) ? (yield* fs.stat(path)).mode & 0o777 : 0o600;
	const temporary = yield* fs.makeTempFile({ directory, prefix: `.${nodePath.basename(path)}.`, suffix: ".tmp" });
	yield* fs
		.writeFileString(temporary, edited.endsWith("\n") ? edited : `${edited}\n`)
		.pipe(
			Effect.andThen(fs.chmod(temporary, mode)),
			Effect.andThen(fs.rename(temporary, path)),
			Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
		);
});

/**
 * Serialize one read-modify-rename of `path` across CLI processes. Only the local edit is locked, so
 * work that precedes it does not wait behind another process.
 */
export const locked = <A, E, R>(path: string, edit: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const nodePath = yield* Path.Path;
		yield* fs.makeDirectory(nodePath.dirname(path), { recursive: true });
		yield* Plugin.settingsLock(
			`${path}.lock`,
			() => new InvalidInputError({ message: `timed out waiting to edit ${path}` }),
		);
		return yield* edit;
	}).pipe(Effect.scoped);

export * as Jsonc from "./jsonc.ts";
