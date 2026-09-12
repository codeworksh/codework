/*
 * @file Host discovery and loading for settings files.
 *
 * Three layers are read, lowest priority first, each merged onto the built-in defaults so
 * that "no file anywhere" needs no special case -- zero patches over the defaults is a
 * valid result:
 *
 * 1. `<Global.home>/settings.json`            -- the user's own, `~/.codework` by default
 * 2. `<options.cwd>/codework.json` or, when absent, `<options.cwd>/.codework/settings.json`
 *                                             -- committed with the project; the single file
 *                                                wins, it is never merged with the directory
 * 3. `<--user-config-dir>/settings.json`      -- explicit override, `~` expanded, relative to cwd
 *
 * **All three are host paths.** They are resolved from the process's startup directory and
 * `Global.home`, never from a session's `--cwd`, its working directory, or its sandbox
 * mount. A session running in a remote or in-memory sandbox reads the same host files as
 * every other session in the process; there is no per-session settings discovery
 * and no parent-directory search. The startup directory arrives as `options.cwd` and is
 * resolved once, so later `cd` or a session pointed elsewhere changes nothing.
 *
 * `load` re-reads all layers on every call. There is no cache to invalidate and no reload
 * API: an edit lands at the next exchange capture because the next capture goes to disk.
 * A missing file is ordinary. A malformed or unreadable one warns and contributes nothing,
 * so a typo in one layer cannot stop the layers around it from applying.
 */

import { Context, Effect, Layer, Result, Schema, SchemaIssue } from "effect";
import { homedir } from "node:os";
import { Global } from "../global.ts";
import { fileSystem, hostPath } from "../host.ts";
import { merge, normalize } from "./merge.ts";
import { defaults, Patch, type Info } from "./schema.ts";

export interface Options {
	readonly userConfigDir?: string;
	/**
	 * Host startup directory, supplied by the caller -- never `process.cwd()` read
	 * here. The distinction it protects is between the OS process's directory and a
	 * session's sandbox mount, which are unrelated and easy to confuse; requiring it
	 * means a caller cannot get the host layer by forgetting to say which it meant.
	 */
	readonly cwd: string;
}

/**
 * Ordered layers, each a group of candidates where the first file that exists is
 * selected -- a group never contributes more than one file. The project layer's
 * candidates are `codework.json` then `.codework/settings.json`, so a project can
 * pick either layout and the single file takes precedence.
 */
export function paths(home: string, cwd: string, custom?: string): ReadonlyArray<ReadonlyArray<string>> {
	const expanded =
		custom === "~" ? homedir() : custom?.startsWith("~/") ? hostPath.join(homedir(), custom.slice(2)) : custom;
	return [
		[hostPath.join(home, "settings.json")],
		[hostPath.join(cwd, "codework.json"), hostPath.join(cwd, Global.appConfigDir, "settings.json")],
		...(expanded === undefined ? [] : [[hostPath.resolve(cwd, expanded, "settings.json")]]),
	];
}

export class SettingsError extends Schema.TaggedError<SettingsError>()("SettingsError", {
	path: Schema.String,
	reason: Schema.Literals(["read", "parse", "decode"]),
	detail: Schema.String,
}) {}

export const parse = Effect.fn("Settings.parse")(function* (path: string, source: string) {
	const json = yield* Effect.try({
		// Native parsing preserves syntax offsets; Schema validates the normalized value below.
		// oxlint-disable-next-line effecttsgo/prefer-schema-over-json
		// @effect-diagnostics-next-line preferSchemaOverJson:off
		try: (): unknown => JSON.parse(source),
		catch: (error) => {
			const message = error instanceof SyntaxError ? error.message : "";
			const position = /position (\d+)/.exec(message);
			const offset = position === null ? undefined : Number(position[1]);
			const before = offset === undefined ? undefined : source.slice(0, offset).split("\n");
			const location = before === undefined ? "" : ` at ${before.length}:${(before.at(-1)?.length ?? 0) + 1}`;
			return new SettingsError({ path, reason: "parse", detail: `Invalid JSON${location}` });
		},
	});
	return yield* Schema.decodeUnknownEffect(Patch)(normalize(json)).pipe(
		Effect.mapError(
			(error) =>
				new SettingsError({
					path,
					reason: "decode",
					detail: SchemaIssue.makeFormatterStandardSchemaV1()(error.issue)
						.issues.map(
							(issue) =>
								`${issue.path?.map((part) => (typeof part === "object" ? String(part.key) : part)).join(".") ?? "settings"}: invalid value`,
						)
						.join("; "),
				}),
		),
	);
});

export interface Interface {
	/** Await fresh host files at each exchange. No cache, mutation, or reload API. */
	readonly load: Effect.Effect<Info>;
}
export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/settings/settings/Service") {}

export const layer = (options: Options) =>
	Layer.effect(
		Service,
		Effect.gen(function* () {
			const global = yield* Global.Service;
			const files = paths(global.home, hostPath.resolve(options.cwd), options.userConfigDir);
			const attempt = (path: string) =>
				fileSystem.readFileString(path).pipe(
					Effect.mapError((error) => new SettingsError({ path, reason: "read", detail: error.reason._tag })),
					Effect.flatMap((source) => parse(path, source)),
				);
			const load = Effect.fn("Settings.load")(function* () {
				let settings = merge(defaults);
				for (const group of files) {
					for (const path of group) {
						const result = yield* Effect.result(attempt(path));
						if (Result.isSuccess(result)) {
							settings = merge(settings, result.success);
							break;
						}
						const error = result.failure;
						// A missing candidate falls through to the next; anything else selects
						// the file, warns, and the group contributes nothing.
						if (error.reason === "read" && error.detail === "NotFound") continue;
						yield* Effect.logWarning(`Settings: ${error.path}: ${error.reason}: ${error.detail}`);
						break;
					}
				}
				return settings;
			});
			return Service.of({ load: load() });
		}),
	);

export { defaults } from "./schema.ts";
export * as Settings from "./settings.ts";
