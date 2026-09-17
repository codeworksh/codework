/*
 * @file Host discovery and loading for settings files.
 *
 * Three layers are read, lowest priority first, each merged onto the built-in defaults so
 * that "no file anywhere" needs no special case -- zero patches over the defaults is a
 * valid result:
 *
 * 1. `<Global.home>/settings.jsonc`            -- the user's own, `~/.codework` by default
 * 2. `codework.jsonc` or `.codework/settings.jsonc` found from `<options.cwd>` upward
 *                                              -- committed with the project; the nearest file
 *                                                 wins, it is never merged with an outer one
 * 3. `<--user-config-dir>/settings.jsonc`     -- explicit override, `~` expanded, relative to cwd
 *
 * Every layer falls back to the `.json` spelling when the `.jsonc` one is absent.
 *
 * **All three are host paths.** They are resolved from the process's startup directory and
 * `Global.home`, never from a session's `--cwd`, its working directory, or its sandbox
 * mount. A session running in a remote or in-memory sandbox reads the same host files as
 * every other session in the process; there is no per-session settings discovery. The startup
 * directory arrives as `options.cwd` and is resolved once, so later `cd` or a session pointed
 * elsewhere changes nothing.
 *
 * `load` re-reads all layers on every call. There is no cache to invalidate and no reload
 * API: an edit lands at the next exchange capture because the next capture goes to disk.
 *
 * A missing file is ordinary; a file that exists and cannot be used is not. An unreadable,
 * unparseable or invalid file fails the read with the path, the reason and the offending key.
 * The alternative -- warn and skip the layer -- discards everything else that file configured,
 * so one typo in `plugins` silently moves a session onto a different model, and the only signal
 * is a log line. Failing is what gets it fixed.
 */

import { Context, Effect, Layer, Predicate, Result, Schema, SchemaIssue } from "effect";
import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { Global } from "../global.ts";
import { fileSystem, hostPath } from "../host.ts";
import { expandTilde } from "../util/home.ts";
import { merge, normalize } from "./merge.ts";
import { defaults, Patch, type Info, type PluginEntry } from "./schema.ts";

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

/** The layouts and spellings a project may use, in the order a directory is searched. */
const project = (directory: string): ReadonlyArray<string> => [
	hostPath.join(directory, "codework.jsonc"),
	hostPath.join(directory, "codework.json"),
	hostPath.join(directory, Global.appConfigDir, "settings.jsonc"),
	hostPath.join(directory, Global.appConfigDir, "settings.json"),
];

/** The startup directory and every ancestor above it, nearest first. */
const ancestors = (from: string): ReadonlyArray<string> => {
	const chain: string[] = [];
	for (let directory = from; ; directory = hostPath.dirname(directory)) {
		chain.push(directory);
		if (hostPath.dirname(directory) === directory) return chain;
	}
};

/**
 * Ordered layers, each a group of candidates where the first file that exists is selected -- a
 * group never contributes more than one file.
 *
 * `.jsonc` is the canonical spelling: these files are written by hand and read as JSONC, so the
 * extension says what the file is and an editor validates it as such. `.json` remains a fallback
 * everywhere, tried second, because the parser reads either and a file already named that must
 * keep working.
 *
 * The project layer searches the startup directory and then its ancestors, so a command run from
 * `packages/app` reads the repository's own `codework.jsonc` rather than silently falling back to
 * defaults. Nearest wins: the search stops at the first directory that has a file, so an inner
 * project is never merged with an outer one.
 */
export function paths(home: string, cwd: string, custom?: string): ReadonlyArray<ReadonlyArray<string>> {
	const expanded = custom === undefined ? undefined : expandTilde(custom, hostPath);
	const explicit = expanded === undefined ? undefined : hostPath.resolve(cwd, expanded);
	const user = [hostPath.join(home, "settings.jsonc"), hostPath.join(home, "settings.json")];
	const userFiles = new Set(user.map((path) => hostPath.resolve(path)));
	return [
		user,
		// The global file can sit under an ancestor of the project (the default is
		// `<user>/.codework`). It is already its own layer and must not re-enter here.
		ancestors(cwd)
			.flatMap(project)
			.filter((path) => !userFiles.has(hostPath.resolve(path))),
		...(explicit === undefined
			? []
			: [[hostPath.join(explicit, "settings.jsonc"), hostPath.join(explicit, "settings.json")]]),
	];
}

export class SettingsError extends Schema.TaggedError<SettingsError>()("SettingsError", {
	path: Schema.String,
	reason: Schema.Literals(["read", "parse", "decode"]),
	detail: Schema.String,
}) {
	override get message(): string {
		return `${this.path}: ${this.reason}: ${this.detail}`;
	}
}

/** `line:column`, 1-based, for a parser offset into the source. */
const at = (source: string, offset: number): string => {
	const before = source.slice(0, offset).split("\n");
	return `${before.length}:${(before.at(-1)?.length ?? 0) + 1}`;
};

export const parse = Effect.fn("Settings.parse")(function* (path: string, source: string) {
	// JSONC: a settings file is written by hand, so comments and a trailing comma are part of
	// the format rather than mistakes. The parser reports offsets, which become `line:column`
	// below; Schema validates the normalized value after that.
	const errors: ParseError[] = [];
	const json: unknown = parseJsonc(source, errors, { allowTrailingComma: true, disallowComments: false });
	const first = errors[0];
	if (first !== undefined) {
		return yield* new SettingsError({
			path,
			reason: "parse",
			detail: `${printParseErrorCode(first.error)} at ${at(source, first.offset)}`,
		});
	}
	// Normalization reads a `null` as "absent", which is right for a settings patch and wrong
	// inside a plugin's `options`: that block is opaque, and `{ "endpoint": null }` is a value
	// its plugin may need. The `plugins` array is therefore decoded exactly as written.
	const document = normalize(json);
	if (Predicate.isObject(document) && Predicate.isObject(json) && "plugins" in json) {
		Object.assign(document, { plugins: json.plugins });
	}
	return yield* Schema.decodeUnknownEffect(Patch)(document).pipe(
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
	/**
	 * Await fresh host files at each exchange. No cache, mutation, or reload API. Fails when a
	 * file exists and cannot be used, including on an edit made mid-session.
	 */
	readonly load: Effect.Effect<Info, SettingsError>;
}
export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/settings/settings/Service") {}

/**
 * Anchor relative plugin entries to the file that declared them.
 *
 * A reference is otherwise resolved against the host startup directory, which is right for
 * a project file sitting in it and meaningless for `~/.codework/settings.json`, where
 * `./plugins/x.ts` would name a different file in every project the process is started in.
 * `file:` URLs, package specs and package names are left exactly as written, and a `plugin`
 * key is an ID rather than a location. A configuration entry's `package` is anchored like a
 * module entry, so a relative path names the same module in both spellings.
 */
const anchor = (patch: Patch, file: string): Patch => {
	if (patch.plugins === undefined) return patch;
	const directory = hostPath.dirname(file);
	const resolve = (reference: string) =>
		reference.startsWith("./") || reference.startsWith("../") ? hostPath.resolve(directory, reference) : reference;
	return {
		...patch,
		plugins: patch.plugins.map((entry) => {
			if (typeof entry === "string") return resolve(entry);
			return "package" in entry ? { ...entry, package: resolve(entry.package) } : entry;
		}),
	};
};

const attempt = (path: string) =>
	fileSystem.readFileString(path).pipe(
		Effect.mapError((error) => new SettingsError({ path, reason: "read", detail: error.reason._tag })),
		Effect.flatMap((source) => parse(path, source)),
	);

/**
 * One read of every layer. Exported for the harness constructor, which needs the plugin
 * selection before any layer is built; everything else goes through `Service`.
 */
export const load = Effect.fn("Settings.load")(function* (options: Options & { readonly home: string }) {
	const files = paths(options.home, hostPath.resolve(options.cwd), options.userConfigDir);
	let settings = merge(defaults);
	/*
	 * Plugin entries accumulate across layers, in layer order, rather than the higher file
	 * replacing the lower one. Every other key in the document merges, and a plugin list is no
	 * different in kind: a user's own plugins are the defaults a project builds on. A project
	 * that wants one gone says so in its own file, with `{ "plugin": "<id>", "enabled": false }`
	 * -- the same entry it would use to turn off a built-in.
	 *
	 * They are carried outside `merge` for a second reason: that walk drops `null`, which inside
	 * an opaque `options` block is a value the plugin may need.
	 */
	let plugins: ReadonlyArray<PluginEntry> = defaults.plugins;
	for (const group of files) {
		for (const path of group) {
			const result = yield* Effect.result(attempt(path));
			if (Result.isSuccess(result)) {
				const patch = anchor(result.success, path);
				settings = merge(settings, patch);
				if (patch.plugins !== undefined) plugins = [...plugins, ...patch.plugins];
				break;
			}
			// A missing candidate falls through to the next; anything else selects the file, and a
			// file this layer selected has to be usable.
			const error = result.failure;
			if (error.reason === "read" && error.detail === "NotFound") continue;
			return yield* error;
		}
	}
	return { ...settings, plugins };
});

export const layer = (options: Options) =>
	Layer.effect(
		Service,
		Effect.gen(function* () {
			const global = yield* Global.Service;
			return Service.of({ load: load({ ...options, home: global.home }) });
		}),
	);

export { defaults } from "./schema.ts";
export * as Settings from "./settings.ts";
