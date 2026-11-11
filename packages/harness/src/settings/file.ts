/*
 * @file Reading and editing one settings file -- `settings.jsonc` or `mcp.json` -- for the CLI and
 * the app server.
 *
 * Edits go through `jsonc-parser`, so a hand-written file keeps its comments, key order and
 * formatting. A write is a temp file renamed over the original under the settings lock, so an
 * interrupted run leaves the previous file intact and two writers never interleave.
 *
 * `replace` and `set` refuse to write a file the runtime would reject: an invalid `settings.jsonc`
 * fails every turn in its project, so the check has to happen before the write, not at the next
 * turn.
 */

import { Effect, Schema } from "effect";
import { applyEdits, modify } from "jsonc-parser";
import { fileSystem, hostPath } from "../host.ts";
import * as McpConfig from "../mcp/config.ts";
import { lock } from "../plugin/lock.ts";
import * as Hash from "../util/hash.ts";
import * as Jsonc from "../util/jsonc.ts";
import { parse as decode, SettingsError, type Target } from "./settings.ts";

/** The file changed since the caller read it. */
export class SettingsConflictError extends Schema.TaggedError<SettingsConflictError>()("SettingsConflictError", {
	path: Schema.String,
}) {
	override get message(): string {
		return `${this.path} changed since it was read`;
	}
}

/** What a caller holds to write back: a missing file reads as empty. */
export const version = (source: string) => Hash.sha256(source);

export const read = Effect.fn("SettingsFile.read")(function* (path: string) {
	const exists = yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));
	const source = exists
		? yield* fileSystem
				.readFileString(path)
				.pipe(Effect.mapError((error) => new SettingsError({ path, reason: "read", detail: error.reason._tag })))
		: "";
	return { source, exists, version: version(source) };
});

/** The file's JSONC as a value, an empty file as `{}`; or why it does not parse. */
export const parse = (source: string) => Jsonc.parse(source.trim() === "" ? "{}" : source);

/** Fails with what the runtime would reject in `source` as `target`'s file. */
export const check = Effect.fn("SettingsFile.check")(function* (target: Target, source: string) {
	// An empty file is no settings at all, not a syntax error.
	const text = source.trim() === "" ? "{}" : source;
	if (target.kind === "settings") return yield* Effect.asVoid(decode(target.path, text));
	const errors = yield* McpConfig.check({
		path: target.path,
		source: text,
		scope: target.scope,
		userDir: target.userDir,
	});
	if (errors.length > 0)
		return yield* new SettingsError({
			path: target.path,
			reason: "decode",
			detail: errors.map((error) => error.replace(`${target.path}: `, "")).join("; "),
		});
});

/** `source` with the value at `at` set, or removed when `value` is undefined. */
export const edit = (source: string, at: ReadonlyArray<string | number>, value: unknown) =>
	// A removal is formatted too: unformatted, removing a first key leaves `{"next": {` on one line.
	applyEdits(source, modify(source, [...at], value, { formattingOptions: { tabSize: 2, insertSpaces: false } }));

/**
 * Write `text` over `path`, keeping its mode; a new file is private to its owner. Callers hold the
 * settings lock, so one fixed temp name beside the file is enough -- `makeTempFile` would leave a
 * directory behind for every write.
 */
export const save = Effect.fn("SettingsFile.save")(function* (path: string, text: string) {
	const directory = hostPath.dirname(path);
	yield* fileSystem.makeDirectory(directory, { recursive: true });
	const mode = (yield* fileSystem.exists(path)) ? (yield* fileSystem.stat(path)).mode & 0o777 : 0o600;
	const temporary = hostPath.join(directory, `.${hostPath.basename(path)}.tmp`);
	yield* fileSystem
		.writeFileString(temporary, text.endsWith("\n") ? text : `${text}\n`)
		.pipe(
			Effect.andThen(fileSystem.chmod(temporary, mode)),
			Effect.andThen(fileSystem.rename(temporary, path)),
			Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
		);
});

/** Run one read-modify-write of `path` under the settings lock, across processes. */
export const locked = <A, E, R, T>(path: string, onTimeout: () => T, change: Effect.Effect<A, E, R>) =>
	lock(`${path}.lock`, onTimeout).pipe(Effect.andThen(change), Effect.scoped);

const timeout = (path: string) => () =>
	new SettingsError({ path, reason: "write", detail: "timed out waiting to edit" });

/** {@link locked}, failing as the file's own write error. */
const exclusive = <A, E, R>(path: string, change: Effect.Effect<A, E, R>) =>
	lock(`${path}.lock`, timeout(path)).pipe(
		Effect.catchTag("LockError", (error) =>
			Effect.fail(new SettingsError({ path, reason: "write", detail: error.message })),
		),
		Effect.andThen(change),
		Effect.scoped,
	);

const written = (path: string, text: string) =>
	save(path, text).pipe(
		Effect.mapError((error) => new SettingsError({ path, reason: "write", detail: error.message })),
		Effect.as(version(text.endsWith("\n") ? text : `${text}\n`)),
	);

/** The whole file, as the editor holds it: written only when the file is still at `expected`. */
export const replace = Effect.fn("SettingsFile.replace")(function* (target: Target, source: string, expected: string) {
	return yield* exclusive(
		target.path,
		Effect.gen(function* () {
			const current = yield* read(target.path);
			if (current.version !== expected) return yield* new SettingsConflictError({ path: target.path });
			yield* check(target, source);
			return yield* written(target.path, source);
		}),
	);
});

/** One value, applied in place over whatever the file holds now. */
export const set = Effect.fn("SettingsFile.set")(function* (
	target: Target,
	at: ReadonlyArray<string | number>,
	value: unknown,
) {
	return yield* exclusive(
		target.path,
		Effect.gen(function* () {
			const current = yield* read(target.path);
			const text = edit(current.source.trim() === "" ? "{}" : current.source, at, value);
			yield* check(target, text);
			return yield* written(target.path, text);
		}),
	);
});
