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
const aliases = (reference: string, directory: string): ReadonlyArray<string> => {
	try {
		return [reference, Plugin.canonical(reference, directory)];
	} catch {
		return [reference];
	}
};

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
			for (const alias of aliases(module, directory)) answers.add(alias);
			const declared = yield* Plugin.inspect(module, {
				cache,
				hostCwd: directory,
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

/** `reference` selects `entry` when any spelling of one is a spelling of the other. */
export const matches = (entry: Entry, reference: string, directory: string) =>
	aliases(reference, directory).some((alias) => entry.answers.has(alias));

/** Every entry connected to a reference through a package spelling or declared plugin ID. */
export const matching = (entries: ReadonlyArray<Entry>, reference: string, directory: string) => {
	const answers = new Set(aliases(reference, directory));
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
 * The project file is found the way the harness finds it: the startup directory first, then its
 * ancestors, so a command run from `packages/app` edits the repository's own file rather than
 * creating a second one beside it. Only when no ancestor has one is a new file written here.
 *
 * There is nothing to warn about between layers: plugin entries from every layer accumulate, so a
 * user-wide entry still applies inside a project that declares its own.
 */
export const resolveTarget = Effect.fn("CLI.plugin.resolveTarget")(function* (shared: Shared, global: boolean) {
	const fs = yield* FileSystem.FileSystem;
	const nodePath = yield* Path.Path;
	const cwd = nodePath.resolve(".");
	const home = yield* Global.resolve(Option.isNone(shared.home) ? {} : { home: shared.home.value });
	const groups = Settings.paths(home.home, cwd, Option.getOrUndefined(shared.userConfigDir));
	// `paths` is ordered lowest priority first: user-wide, then project, then an explicit directory.
	const chosen = Option.isSome(shared.userConfigDir) ? groups.length - 1 : global ? 0 : 1;
	const candidates = groups[chosen] ?? [];
	const existing = yield* Effect.findFirst(candidates, (candidate) => fs.exists(candidate));
	const path = Option.getOrElse(existing, () => candidates[0] ?? nodePath.join(home.home, "settings.jsonc"));
	return { path } satisfies Target;
});
