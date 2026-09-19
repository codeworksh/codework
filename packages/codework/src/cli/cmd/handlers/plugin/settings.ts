import { Global, Plugin, Settings } from "@codeworksh/harness/effect";
import { Effect, FileSystem, Option, Path } from "effect";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import { InvalidInputError } from "../../../error.ts";

/**
 * Reading and rewriting the `plugins` array of one settings file.
 *
 * Edits go through `jsonc-parser`, so a hand-written file keeps its comments, key order and
 * formatting: a plugin added by the CLI must not reformat a file its owner maintains. The write
 * is a temp file renamed over the original, so an interrupted run leaves the previous settings
 * intact rather than a half-written document.
 */

export interface Shared {
	readonly userConfigDir: Option.Option<string>;
	readonly home: Option.Option<string>;
}

export interface Target {
	readonly path: string;
	/** Set when this command had to create the project directory, so the caller can say so. */
	readonly created?: string;
	/** The project this file belongs to, which a local entry is written relative to. */
	readonly root?: string;
}

/** The module an entry names: a bare loader string, or the `package` of a config object. */
const moduleOf = (entry: unknown): string | undefined => {
	if (typeof entry === "string") return entry;
	if (typeof entry !== "object" || entry === null) return undefined;
	const { package: located } = entry as { package?: unknown };
	return typeof located === "string" ? located : undefined;
};

/** The plugin ID an entry configures, if it names one. */
const idOf = (entry: unknown): string | undefined => {
	if (typeof entry !== "object" || entry === null) return undefined;
	const { plugin } = entry as { plugin?: unknown };
	return typeof plugin === "string" ? plugin : undefined;
};

/**
 * Every spelling a reference answers to, without touching the filesystem.
 *
 * `canonical` drops a version suffix and resolves a relative path against the file that declared
 * it, so `@acme/x@1.2.0` and `@acme/x` are one name. The literal string is kept alongside it
 * because a plugin ID is not a module reference and survives `canonical` unchanged.
 */
const aliases = (reference: string, directory: string): Effect.Effect<ReadonlyArray<string>> =>
	Plugin.canonical(reference, directory).pipe(
		Effect.map((canonical) => [reference, canonical] as ReadonlyArray<string>),
		// A reference that does not parse still answers to itself: a plugin ID is not a module
		// reference, and it has to keep matching an entry that names it.
		Effect.orElseSucceed(() => [reference] as ReadonlyArray<string>),
	);

/** Every spelling `reference` answers to, computed once for a whole command. */
export const spellings = (reference: string, directory: string): Effect.Effect<ReadonlySet<string>> =>
	Effect.map(aliases(reference, directory), (found) => new Set(found));

export interface Entry {
	readonly value: unknown;
	readonly answers: ReadonlySet<string>;
	readonly loads: boolean;
}

/**
 * What each configured entry answers to.
 *
 * Comparing the string as written is not enough. `plugin add @acme/x@1.2.0` records a version the
 * user will not repeat when removing it, and one plugin can be named three ways: by package, by
 * path, or by the ID it declares -- a `{ "plugin": "<id>" }` configuration object sits next to the
 * module entry that loaded it, and removing the plugin has to take both.
 *
 * The declared ID is only knowable by importing the module, so it is read from what is already
 * installed: `resolveCached` reads a published package out of the harness cache and never runs an
 * installer, so editing a settings file cannot fetch anything. An entry that does not resolve --
 * uninstalled, moved, or broken -- keeps the names it was written with rather than failing the
 * command, because an unusable plugin is exactly the one a user is trying to remove.
 */
export const identify = Effect.fn("CLI.plugin.identify")(function* (
	plugins: ReadonlyArray<unknown>,
	file: string,
	cache: string,
) {
	const nodePath = yield* Path.Path;
	const directory = nodePath.dirname(file);
	const entries: Entry[] = [];
	for (const value of plugins) {
		const answers = new Set<string>();
		const id = idOf(value);
		if (id !== undefined) answers.add(id);
		const module = moduleOf(value);
		if (module !== undefined) {
			for (const alias of yield* aliases(module, directory)) answers.add(alias);
			const declared = yield* Plugin.inspect(module, {
				cache,
				hostDir: directory,
				install: Plugin.resolveCached,
			}).pipe(Effect.option);
			if (Option.isSome(declared)) {
				answers.add(declared.value.id);
				if (declared.value.name !== undefined) answers.add(declared.value.name);
			}
		}
		entries.push({ value, answers, loads: typeof value === "string" });
	}
	return entries as ReadonlyArray<Entry>;
});

/**
 * What a local reference should be *written* as, which is rarely what was typed.
 *
 * A relative path on the command line is relative to `cwd`; in a settings file it is relative to
 * that file's own directory. Those differ the moment the command runs anywhere but the directory
 * holding the file, and writing the string verbatim produces a silently wrong entry:
 *
 * ```
 * $ cd ~/workspace/app/packages/fubar
 * $ codework plugin add ./plugins/x.ts        # means packages/fubar/plugins/x.ts
 *   → the project is ~/workspace/app, so the entry lands in app/.codework/settings.jsonc
 *   → written verbatim, the harness loads app/.codework/plugins/x.ts   ← a different file
 * ```
 *
 * With both ends inside one project the entry is written relative to the file, which is portable
 * to any checkout of that repository and therefore worth committing. Otherwise -- a `-g` write
 * into `<home>`, a `--user-config-dir` elsewhere, or a target outside the project -- relative
 * would be a lie, and an absolute path means the same thing read from anywhere.
 *
 * A package spec is returned untouched: it names no location.
 */
export const written = Effect.fn("CLI.plugin.written")(function* (
	reference: string,
	input: { readonly cwd: string; readonly file: string; readonly root: string | undefined },
) {
	const nodePath = yield* Path.Path;
	const target = yield* Plugin.parse(reference, input.cwd).pipe(Effect.option);
	if (Option.isNone(target) || target.value.kind !== "local") return reference;

	const absolute = target.value.path;
	const inside = (root: string, path: string) => path === root || path.startsWith(`${root}${nodePath.sep}`);
	if (input.root !== undefined && inside(input.root, input.file) && inside(input.root, absolute)) {
		const relative = nodePath.relative(nodePath.dirname(input.file), absolute);
		return relative.startsWith("..") ? relative : `./${relative}`;
	}
	return absolute;
});

/** `reference` selects `entry` when any spelling of one is a spelling of the other. */
export const matches = (entry: Entry, spelled: ReadonlySet<string>) =>
	[...spelled].some((alias) => entry.answers.has(alias));

/** Every entry connected to a reference through a package spelling or declared plugin ID. */
export const matching = (entries: ReadonlyArray<Entry>, spelled: ReadonlySet<string>) => {
	const answers = new Set(spelled);
	const found = new Set<Entry>();
	for (;;) {
		const next = entries.filter(
			(entry) => !found.has(entry) && [...entry.answers].some((answer) => answers.has(answer)),
		);
		if (next.length === 0) return found as ReadonlySet<Entry>;
		for (const entry of next) {
			found.add(entry);
			for (const answer of entry.answers) answers.add(answer);
		}
	}
};

export const readPlugins = Effect.fn("CLI.plugin.readPlugins")(function* (path: string) {
	const fs = yield* FileSystem.FileSystem;
	const exists = yield* fs.exists(path);
	const source = exists ? yield* fs.readFileString(path) : "{}";
	const errors: ParseError[] = [];
	const document: unknown = parseJsonc(source, errors, { allowTrailingComma: true });
	if (errors.length > 0 || typeof document !== "object" || document === null || Array.isArray(document)) {
		return yield* new InvalidInputError({ message: `${path} is not a valid settings file` });
	}
	const plugins = (document as { plugins?: unknown }).plugins;
	if (plugins !== undefined && !Array.isArray(plugins)) {
		return yield* new InvalidInputError({ message: `${path}: "plugins" must be an array` });
	}
	return { source, plugins: (plugins ?? []) as ReadonlyArray<unknown> };
});

export const writePlugins = Effect.fn("CLI.plugin.writePlugins")(function* (
	path: string,
	source: string,
	plugins: ReadonlyArray<unknown>,
) {
	const fs = yield* FileSystem.FileSystem;
	const nodePath = yield* Path.Path;
	const edited = applyEdits(
		source,
		modify(source, ["plugins"], plugins, { formattingOptions: { tabSize: 2, insertSpaces: false } }),
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
 * Which file the edit lands in.
 *
 * A plugin belongs to a project by default — it is part of how that repository is worked on, so
 * the entry belongs in a file the repository can commit. `--global` writes the user-wide file
 * instead, the way `npm -g` installs outside a package. An explicit `--user-config-dir` outranks
 * both, since naming a settings directory is already a decision about where settings live.
 *
 * The project is found the way the harness finds it: the nearest ancestor holding a `.codework`
 * directory, so a command run from `packages/app` edits the repository's own file rather than
 * creating a second one beside it. When no ancestor has one, the project begins here -- the
 * directory is created and the caller is told, because that decision changes where every future
 * plugin entry lands, and a mistyped `cd` is the way it goes wrong.
 *
 * There is nothing to warn about between layers: plugin entries from every layer accumulate, so a
 * user-wide entry still applies inside a project that declares its own.
 */
export const resolveTarget = Effect.fn("CLI.plugin.resolveTarget")(function* (shared: Shared, global: boolean) {
	const fs = yield* FileSystem.FileSystem;
	const nodePath = yield* Path.Path;
	const cwd = nodePath.resolve(".");
	const home = yield* Global.resolve(Option.isNone(shared.home) ? {} : { home: shared.home.value });
	const root = global ? undefined : yield* Settings.projectRoot(cwd, home.home);
	// `paths` is ordered lowest priority first: user-wide, then project, then an explicit directory.
	const groups = Settings.paths({
		home: home.home,
		...(root === undefined ? {} : { root }),
		from: cwd,
		...(Option.isNone(shared.userConfigDir) ? {} : { custom: shared.userConfigDir.value }),
	});
	const chosen = Option.isSome(shared.userConfigDir) ? groups.length - 1 : global ? 0 : 1;
	// An empty group is the project layer saying there is no project above this directory. Then
	// this directory becomes one -- reported, not silent, because the marker shadows any outer
	// project from now on, so a `.codework/` created by a mistyped `cd` is worth spotting at once.
	const found = groups[chosen] ?? [];
	if (found.length > 0) {
		const existing = yield* Effect.findFirst(found, (candidate) => fs.exists(candidate));
		return {
			path: Option.getOrElse(existing, () => found[0]!),
			...(root === undefined ? {} : { root }),
		} satisfies Target;
	}
	const marker = nodePath.join(cwd, ".codework");
	yield* fs.makeDirectory(marker, { recursive: true });
	return { path: nodePath.join(marker, "settings.jsonc"), created: marker, root: cwd } satisfies Target;
});
