/*
 * @file Host discovery and loading for settings files.
 *
 * Two layers are read, lowest priority first, each merged onto the built-in defaults so that
 * "no file anywhere" needs no special case -- zero patches over the defaults is a valid result:
 *
 * 1. **user** -- `<--user-config-dir>/settings.jsonc` when that flag is given, otherwise
 *    `<--home>/settings.jsonc` (`~/.codework` by default). The flag is a hard override of this
 *    one file: the home's own settings are then not read at all, while everything else the home
 *    holds -- credentials, cache, data -- stays where `--home` says.
 * 2. **project** -- `.codework/settings.jsonc` found from `<hostDir>` upward, committed with the
 *    project; the nearest file wins, it is never merged with an outer one.
 *
 * Every layer falls back to the `.json` spelling when the `.jsonc` one is absent.
 *
 * **Both are host paths, and they come from different directories:**
 *
 * - `hostCwd` -- the app process's working directory. `--home` and `--user-config-dir` are
 *   app-level flags, so a relative spelling of either resolves here ({@link userConfigDir}).
 * - `hostDir` -- the host directory a session is linked to. The project layer is discovered from
 *   it, and from nothing else.
 * - `cwd` -- a session's sandbox working directory, where the work happens. It names a place
 *   inside a mount that may not exist on this machine; settings are never discovered from it,
 *   because a path that happens to exist here too would silently select a stranger's project.
 *
 * `hostDir` is per call, because one process serves sessions in different projects, or in none.
 * A session with none reads the user layer only: there is no fallback to the process's own
 * directory, because that would answer with the wrong project rather than with no project.
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
import { defaults, Patch, type Declared, type Info, type PluginEntry } from "./schema.ts";

export interface Options {
	/**
	 * `--user-config-dir`, already absolute ({@link userConfigDir}): the directory whose settings
	 * file replaces the user layer's.
	 */
	readonly userConfigDir?: string;
	/**
	 * The host directory this load discovers the project layer from, supplied by the caller --
	 * never `process.cwd()` read here. The distinction it protects is between the OS process's
	 * directory and a session's sandbox mount, which are unrelated and easy to confuse.
	 *
	 * Absent means the caller has no host directory, not "use a sensible one": the project layer
	 * is skipped entirely and only the user layer is read. There is deliberately no fallback --
	 * a fallback would hand a session the *wrong* project (whatever the process happened to start
	 * in, walked upward, possibly matching a `.codework/` in a base image), which is an invisible
	 * wrong answer. No project is a visible missing one, and a missing plugin is something a
	 * person notices and can diagnose.
	 */
	readonly hostDir?: string | undefined;
}

/**
 * An app-level `--user-config-dir` as the absolute directory it names: `~` is the user's home, and
 * a relative spelling is relative to `hostCwd` -- never to a session's `hostDir`, which is not
 * where the flag was typed.
 */
export const userConfigDir = (raw: string, hostCwd: string): string =>
	hostPath.resolve(hostCwd, expandTilde(raw, hostPath));

/** The settings files a directory may hold, in the order it is searched. */
const settingsIn = (directory: string): ReadonlyArray<string> => [
	hostPath.join(directory, "settings.jsonc"),
	hostPath.join(directory, "settings.json"),
];

/** A directory and every ancestor above it, nearest first. */
const ancestors = (from: string): ReadonlyArray<string> => {
	const chain: string[] = [];
	for (let directory = from; ; directory = hostPath.dirname(directory)) {
		chain.push(directory);
		if (hostPath.dirname(directory) === directory) return chain;
	}
};

const isDirectory = (path: string) =>
	fileSystem.stat(path).pipe(
		Effect.map((info) => info.type === "Directory"),
		Effect.orElseSucceed(() => false),
	);

/**
 * The project a directory is in: the nearest ancestor holding a `.codework` **directory**.
 *
 * This is git's rule. `~/workspace/app/.codework` makes `~/workspace/app` a project, and
 * `~/workspace/app/packages/fubar` is inside it. Nearest wins outright -- the walk stops at the
 * first marker, so an inner project is never merged with an outer one.
 *
 * The marker is the directory, not a file in it. An empty `.codework/` is still a project root,
 * which is the point: creating the directory is how a person says "a project begins here", and it
 * has to mean that before any settings exist. It also makes the question one `stat` per ancestor
 * whose answer does not change as files come and go inside.
 *
 * `<home>` is skipped. `~/.codework` is the user layer, not a project; without this, running
 * anywhere under `$HOME` would find it as one and read the user layer twice -- and since plugin
 * entries accumulate across layers, every user plugin would load twice.
 */
export const projectRoot = Effect.fn("Settings.projectRoot")(function* (from: string, home: string) {
	const userConfig = hostPath.resolve(home);
	for (const directory of ancestors(hostPath.resolve(from))) {
		const marker = hostPath.join(directory, Global.appConfigDir);
		if (hostPath.resolve(marker) === userConfig) continue;
		if (yield* isDirectory(marker)) return directory;
	}
	return undefined;
});

/**
 * Ordered layers, each a group of candidates where the first file that exists is selected -- a
 * group never contributes more than one file.
 *
 * `.jsonc` is the canonical spelling: these files are written by hand and read as JSONC, so the
 * extension says what the file is and an editor validates it as such. `.json` remains a fallback
 * everywhere, tried second, because the parser reads either and a file already named that must
 * keep working.
 *
 * `root` is an already-discovered project root ({@link projectRoot}), not a directory to search
 * from: the walk is a `stat` per ancestor and belongs with the other I/O. `undefined` contributes
 * no project layer at all, which is what a session with no host directory gets.
 */
export function paths(input: {
	readonly home: string;
	/** The project root, from {@link projectRoot}. */
	readonly root?: string | undefined;
	/** `--user-config-dir`, absolute ({@link userConfigDir}): replaces the home's settings. */
	readonly userConfigDir?: string | undefined;
}): ReadonlyArray<ReadonlyArray<string>> {
	return [
		settingsIn(input.userConfigDir ?? input.home),
		// No project root, no project layer -- an empty group contributes nothing, so this needs
		// no branch downstream.
		input.root === undefined ? [] : settingsIn(hostPath.join(input.root, Global.appConfigDir)),
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
	 *
	 * The discovery root is an argument rather than a property of the layer because it is a
	 * property of the *session*: one process serves sessions in different projects, or in none,
	 * and a layer-level directory could not express that. `undefined` is the honest answer for a
	 * session that was never given one -- the user layer alone, with no walk (see {@link Options}).
	 */
	readonly load: (hostDir: string | undefined) => Effect.Effect<Info, SettingsError>;
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
const anchored = (entry: PluginEntry, file: string): PluginEntry => {
	const directory = hostPath.dirname(file);
	const resolve = (reference: string) =>
		reference.startsWith("./") || reference.startsWith("../") ? hostPath.resolve(directory, reference) : reference;
	if (typeof entry === "string") return resolve(entry);
	return "package" in entry ? { ...entry, package: resolve(entry.package) } : entry;
};

const anchor = (patch: Patch, file: string): Patch =>
	patch.plugins === undefined ? patch : { ...patch, plugins: patch.plugins.map((entry) => anchored(entry, file)) };

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
	const root = options.hostDir === undefined ? undefined : yield* projectRoot(options.hostDir, options.home);
	const files = paths({
		home: options.home,
		root,
		...(options.userConfigDir === undefined ? {} : { userConfigDir: options.userConfigDir }),
	});
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
	let declared: ReadonlyArray<Declared> = defaults.declared;
	for (const group of files) {
		for (const path of group) {
			const result = yield* Effect.result(attempt(path));
			if (Result.isSuccess(result)) {
				const patch = anchor(result.success, path);
				settings = merge(settings, patch);
				// Each entry keeps the file that declared it: it is what anchors a relative path,
				// what `plugin list` names, and what the missing-plugin diagnostic points at.
				if (result.success.plugins !== undefined) {
					declared = [
						...declared,
						...result.success.plugins.map((written) => ({
							written,
							entry: anchored(written, path),
							file: path,
						})),
					];
				}
				break;
			}
			// A missing candidate falls through to the next; anything else selects the file, and a
			// file this layer selected has to be usable.
			const error = result.failure;
			if (error.reason === "read" && error.detail === "NotFound") continue;
			return yield* error;
		}
	}
	return { ...settings, plugins: declared.map((one) => one.entry), declared };
});

/**
 * Each module reference once, owned by the **last** file to declare it (D6).
 *
 * The owner is not bookkeeping: its `.npmrc` chain keys the store artifact. The CLI that installs
 * a reference and the runtime that loads it must pick the same owner, or `plugin update` refreshes
 * an artifact the runtime never reads. Only a string entry loads a module, so only a string entry
 * owns one -- a `{ package }` patch in another file configures it and must not move its registry.
 * A reference keeps the position of its first declaration.
 */
export const modules = (declared: ReadonlyArray<Declared>): ReadonlyMap<string, Declared> => {
	const owners = new Map<string, Declared>();
	for (const one of declared) if (typeof one.entry === "string") owners.set(one.entry, one);
	return owners;
};

export const layer = (options: Omit<Options, "hostDir"> = {}) =>
	Layer.effect(
		Service,
		Effect.gen(function* () {
			const global = yield* Global.Service;
			return Service.of({
				load: (hostDir) => load({ ...options, home: global.home, hostDir }),
			});
		}),
	);

export { defaults } from "./schema.ts";
export * as Settings from "./settings.ts";
