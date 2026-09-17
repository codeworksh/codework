import { Effect, Predicate } from "effect";
import { isRecord } from "../settings/merge.ts";
import * as Loader from "./loader.ts";
import { type Plugin, rank } from "./plugin.ts";

/** Opaque to the harness: a plugin reads and validates its own block. */
export type PluginOptions = { readonly [key: string]: unknown };
/** A module to load: a path, a `file:` URL, or a package spec. Definitions are passed directly. */
export type PluginSpec = Plugin | string;
interface PluginConfig {
	/** `false` drops the plugin from the selection. */
	readonly enabled?: boolean | undefined;
	readonly options?: PluginOptions | undefined;
}
/**
 * Configuration for a plugin something else already selected, naming it by ID (`plugin`) or by
 * the module string it was registered from (`package`) — exactly one of the two. It loads nothing,
 * so a name matching nothing in the selection is ignored rather than fetched.
 */
export type PluginPatch =
	| (PluginConfig & { readonly plugin: string; readonly package?: never })
	| (PluginConfig & { readonly package: string; readonly plugin?: never });
export type PluginRef = PluginSpec | PluginPatch;
export interface Prepared {
	readonly plugin: Plugin;
	readonly options: PluginOptions;
}
export interface Catalog {
	readonly add: (plugin: Plugin, source?: string, version?: string) => void;
	readonly get: (id: string) => Plugin | undefined;
	readonly has: (id: string) => boolean;
}

/** Catalogs belong to one harness configuration. Definitions never execute here. */
export const make = (): Catalog => {
	const entries = new Map<string, { plugin: Plugin; source?: string; version?: string }>();
	return {
		add: (plugin, source, version) => {
			entries.set(plugin.id, {
				plugin,
				...(source === undefined ? {} : { source }),
				...(version === undefined ? {} : { version }),
			});
		},
		get: (id) => entries.get(id)?.plugin,
		has: (id) => entries.has(id),
	};
};

export interface Options extends Loader.Options {
	readonly builtins: ReadonlyArray<Plugin>;
}

/**
 * A definition carries `setup`; a patch carries `plugin` or `package` and no `setup`. Checking
 * `setup` first matters because `Plugin` permits extra properties, so a definition holding its
 * own `plugin` property must not be read as configuration.
 */
const isPatch = (reference: PluginRef): reference is PluginPatch =>
	Predicate.isObject(reference) &&
	!Predicate.isFunction(reference) &&
	!("setup" in reference) &&
	("plugin" in reference || "package" in reference);

/**
 * Resolve every reference to the ordered selection the harness runs.
 *
 * An array entry is a **module** — a definition object, a path, a `file:` URL, or a package
 * spec. It is loaded if it is not already, and it takes the position it is written at, so
 * naming a module again moves it.
 *
 * An object entry is **configuration** for a plugin an earlier entry (or the built-in list)
 * already selected, addressed by its ID (`plugin`) or the module string (`package`) that selected
 * it. It never loads, installs or reorders anything, and a name matching nothing in the selection
 * is ignored rather than failing the boot — a typo costs a debug line, never a fetch.
 */
export const prepare = Effect.fn("PluginCatalog.prepare")(function* (
	references: ReadonlyArray<PluginRef>,
	options: Options,
) {
	const catalog = make();
	const hostCwd = options.hostCwd;
	for (const builtin of options.builtins) {
		catalog.add(yield* Loader.validate(builtin, { index: -1, reference: builtin.id }, true), "builtin");
	}
	/** Source metadata exists for diagnostics; a silent ID replacement is where it earns that. */
	const note = (plugin: Plugin, source: string) =>
		catalog.has(plugin.id)
			? Effect.logDebug(`plugin ${plugin.id} redefined by ${source}; the earlier definition is discarded`)
			: Effect.void;
	/**
	 * Every string a loaded module was registered under, pointing at its ID. Built as the list is
	 * walked, so a `package` entry can only address a module an earlier entry loaded.
	 */
	const aliases = new Map<string, string>();
	const operations = new Map<string, { enabled: boolean; origin: Loader.Origin; options: PluginOptions }>();
	const loaded = new Map<string, Loader.Loaded>();
	/**
	 * An ID is a key: the last module to claim it owns it, and the configuration written against
	 * it stays with the key rather than with whichever module is currently behind it. Two modules
	 * exporting one ID is the author's conflict to resolve; the replacement is logged.
	 */
	const select = (id: string, origin: Loader.Origin) =>
		operations.set(id, { enabled: true, origin, options: operations.get(id)?.options ?? {} });
	for (const [index, reference] of references.entries()) {
		if (isPatch(reference)) {
			// A settings file is decoded before it reaches here; an embedder's array is not, so the
			// entry shape is checked once for both. A contradictory entry is a mistake worth a
			// failure, unlike a name that simply matches nothing.
			const named = reference.plugin ?? reference.package;
			const origin = { index, reference: typeof named === "string" ? named : `<plugin entry #${index}>` };
			const invalid =
				reference.plugin !== undefined && reference.package !== undefined
					? "names both `plugin` and `package`"
					: typeof named !== "string" || named.length === 0
						? "names neither `plugin` nor `package`"
						: reference.enabled !== undefined && typeof reference.enabled !== "boolean"
							? "`enabled` is not a boolean"
							: reference.options !== undefined && !isRecord(reference.options)
								? "`options` is not a plain object"
								: undefined;
			if (invalid !== undefined) {
				return yield* Loader.failure(origin, "definition", new Error(`plugin entry ${invalid}`));
			}
			const id = reference.plugin === undefined ? aliases.get(reference.package) : reference.plugin;
			const operation = id === undefined ? undefined : operations.get(id);
			if (id === undefined || operation === undefined) {
				// Misspelled, not installed, or not shipped by this build: there is nothing to
				// configure, and an entry that loads nothing cannot be worth failing a boot over.
				yield* Effect.logDebug(`plugin configuration ignored: nothing selected under ${named}`);
				continue;
			}
			operations.set(id, {
				enabled: reference.enabled ?? operation.enabled,
				// Position stays with the entry that selected it: configuring never moves a plugin.
				origin: operation.origin,
				// The block is opaque, so the last entry owns it whole rather than merging into
				// values the harness cannot interpret.
				options: reference.options ?? operation.options,
			});
			continue;
		}
		// An entry reaching here is unvalidated and may be anything a JavaScript caller passed,
		// including `null`: read an `id` off it only once it is known to have properties, or
		// `PreparationError.reference` throws instead of reporting the bad entry.
		const declared =
			typeof reference === "string" ? reference : Predicate.hasProperty(reference, "id") ? reference.id : undefined;
		const origin = { index, reference: typeof declared === "string" ? declared : `<plugin object #${index}>` };
		if (typeof reference !== "string") {
			// The very definition the catalog already holds — a built-in named by the default
			// selection. Selecting one is not redefining it, so the reserved namespace stands.
			if (typeof declared === "string" && catalog.get(declared) === reference) {
				select(declared, origin);
				continue;
			}
			const plugin = yield* Loader.validate(reference, origin);
			yield* note(plugin, "a supplied object");
			catalog.add(plugin, "object");
			select(plugin.id, origin);
			continue;
		}
		const source = yield* Effect.try({
			try: () => Loader.classify(reference, hostCwd),
			catch: (cause) => Loader.failure(origin, "source", cause),
		});
		const key = source.kind === "package" ? source.request.spec : source.path;
		const definition = loaded.get(key) ?? (yield* Loader.load(source, origin, options));
		loaded.set(key, definition);
		yield* note(definition.plugin, definition.version === undefined ? key : `${key}@${definition.version}`);
		catalog.add(definition.plugin, definition.source, definition.version);
		// `package` configuration matches the registered module string. Keep its canonical package
		// name/spec or local path too, so a versioned entry can be configured without repeating the
		// version and a relative path remains anchored consistently.
		const names =
			source.kind === "package"
				? [source.request.name, source.request.spec]
				: [source.path, ...(definition.name === undefined ? [] : [definition.name])];
		for (const name of [reference, ...names]) aliases.set(name, definition.plugin.id);
		select(definition.plugin.id, origin);
	}
	const selection: Array<Prepared & { readonly index: number }> = [];
	for (const [id, operation] of operations) {
		// Disabled by a configuration entry. Every other operation was recorded beside the
		// `catalog.add` that registered its definition, so the lookup below cannot miss.
		if (!operation.enabled) continue;
		const plugin = catalog.get(id);
		if (plugin !== undefined) {
			selection.push({ plugin, options: Object.freeze(operation.options), index: operation.origin.index });
		}
	}
	// Domain first, then where the entry was written. Comparing the index explicitly rather than
	// leaning on a stable sort keeps the second half of the rule visible: composition inside one
	// domain -- a plugin patching another's tool, or appending to the prompt it rendered -- still
	// depends on the order those entries were written in.
	selection.sort((a, b) => rank(a.plugin.kind) - rank(b.plugin.kind) || a.index - b.index);
	return Object.freeze(selection.map(({ plugin, options }) => ({ plugin, options }) satisfies Prepared));
});
