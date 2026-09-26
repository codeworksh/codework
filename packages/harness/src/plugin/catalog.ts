import type { PluginOptions, PluginPatch, PluginRef } from "@codeworksh/plugin/plugin";
import { Effect, Option, Predicate } from "effect";
import { isRecord } from "../settings/merge.ts";
import * as Loader from "./loader.ts";
import { type Plugin, rank } from "./plugin.ts";
import { PluginSource } from "./source.ts";

/**
 * How a `plugins` entry is spelled. Declared in `@codeworksh/plugin`, because the shapes are what
 * a plugin author writes into a settings file; what the entries *mean* is this module's job.
 */
export type { PluginOptions, PluginPatch, PluginRef, PluginSpec } from "@codeworksh/plugin/plugin";
export interface Prepared {
	readonly plugin: Plugin;
	readonly options: PluginOptions;
}
export interface Options extends Loader.Options {
	readonly builtins: ReadonlyArray<Plugin>;
	/**
	 * Which settings file declared each reference, so a failure can say where to go and edit.
	 *
	 * Absent for an embedder's own list, which came from code rather than from a file.
	 */
	readonly declared?: ReadonlyMap<string, string> | undefined;
}

/**
 * A definition carries `setup`; a patch carries `plugin` or `package` and no `setup`. Checking
 * `setup` first matters because `Plugin` permits extra properties, so a definition holding its
 * own `plugin` property must not be read as configuration.
 *
 * e.g
 * "acme/tool@1.2.0"                    → module (load me)
 * define({id, kind, setup, ...})       → module (I AM the definition — embedder code only)
 * { plugin: "x", enabled: false }      → config (don't load — adjust something already loaded)
 *
 * setup present → definition, always (even with a stray plugin: key)
 * setup absent + plugin:/package: present → config patch
 * setup absent + neither key → malformed
 */
const isPatch = (reference: PluginRef): reference is PluginPatch =>
	Predicate.isObject(reference) && // 1. objects only — rules out strings, null
	!Predicate.isFunction(reference) && // 2. Effect's isObject counts functions as objects — exclude them
	!("setup" in reference) && // 3. a definition has setup
	("plugin" in reference || "package" in reference); // 4. a patch must name what it configures

/**
 * Everything that has been loaded, and every string that addresses it.
 *
 * This is what the **load pass** produces and the **config pass** consumes. Built-ins are in it
 * from the start: they are objects the harness already holds, with no spec, digest or generation,
 * and from here the config pass cannot tell them apart from a loaded package -- which is what lets
 * `{ "plugin": "codework.tool.bash", "enabled": false }` go through the same code path as
 * disabling anything else.
 */
export interface Pool {
	/** By plugin ID. An ID is a key: the last module to claim it owns it. */
	readonly plugins: ReadonlyMap<string, Plugin>;
	/** Every string a loaded module answers to -- its reference, spec, path, package name -- to its ID. */
	readonly aliases: ReadonlyMap<string, string>;
	/** By ID, for diagnostics. Absent for a built-in and for a local source. */
	readonly versions: ReadonlyMap<string, string>;
	/** What each loaded module was loaded from, which is how {@link follow} tells it has moved. */
	readonly origins: ReadonlyMap<string, Origin>;
}

/** Where a loaded module came from. */
export interface Origin {
	/** The reference as written, so it can be re-resolved against the store. */
	readonly reference: string;
	/**
	 * The store generation it was loaded from. Absent for a built-in, a supplied object and a
	 * local source -- none of which are filed, so none of which can be superseded.
	 */
	readonly generation?: number;
	/**
	 * The settings file that declared the reference, which {@link Loader.anchor} turns into the
	 * `.npmrc` context the entry was filed under. Carried on the origin so a retained module
	 * re-resolves through the same registry on a later load pass, whatever session asked.
	 */
	readonly file?: string;
}

const emptyPool: Pool = {
	plugins: new Map(),
	aliases: new Map(),
	versions: new Map(),
	origins: new Map(),
};

/**
 * The **load pass**: store lookup and ESM import, never the network.
 *
 * Runs at boot, at `reload`, and at any exchange that finds a reference it cannot satisfy. It
 * deliberately knows nothing about `enabled`, options or order -- those are data over modules that
 * are already loaded, they cost a walk of a short array, and they belong to every exchange.
 *
 * Loading is keyed by what a reference resolves to, so naming one module twice imports it once.
 */
export const load = Effect.fn("PluginCatalog.load")(function* (references: ReadonlyArray<PluginRef>, options: Options) {
	const plugins = new Map<string, Plugin>();
	const aliases = new Map<string, string>();
	const versions = new Map<string, string>();
	const origins = new Map<string, Origin>();
	const seen = new Map<string, string>();

	const remember = (
		plugin: Plugin,
		names: ReadonlyArray<string>,
		from?: { readonly version?: string; readonly origin: Origin },
	) => {
		plugins.set(plugin.id, plugin);
		aliases.set(plugin.id, plugin.id);
		for (const name of names) aliases.set(name, plugin.id);
		if (from?.version !== undefined) versions.set(plugin.id, from.version);
		if (from !== undefined) origins.set(plugin.id, from.origin);
	};

	/** Source metadata exists for diagnostics; a silent ID replacement is where it earns that. */
	const note = (plugin: Plugin, source: string) =>
		plugins.has(plugin.id)
			? Effect.logDebug(`plugin ${plugin.id} redefined by ${source}; the earlier definition is discarded`)
			: Effect.void;

	for (const builtin of options.builtins) {
		const plugin = yield* Loader.validate(builtin, { index: -1, reference: builtin.id }, true);
		remember(plugin, []);
	}

	for (const [index, reference] of references.entries()) {
		if (isPatch(reference)) continue; // configuration loads nothing.

		// An entry reaching here is unvalidated and may be anything a JavaScript caller passed,
		// including `null`: read an `id` off it only once it is known to have properties, or
		// `PreparationError.reference` throws instead of reporting the bad entry.
		const declared =
			typeof reference === "string" ? reference : Predicate.hasProperty(reference, "id") ? reference.id : undefined;
		const named = typeof declared === "string" ? declared : `<plugin object #${index}>`;
		const origin = { index, reference: named, file: options.declared?.get(named) };

		if (typeof reference !== "string") {
			// The very definition the pool already holds -- a built-in named by the default
			// selection. Selecting one is not redefining it, so the reserved namespace stands.
			if (typeof declared === "string" && plugins.get(declared) === reference) continue;
			const plugin = yield* Loader.validate(reference, origin);
			yield* note(plugin, "a supplied object");
			remember(plugin, []);
			continue;
		}

		const target = yield* PluginSource.parse(reference, options.hostDir);
		const key = target.kind === "local" ? target.path : target.spec;
		const already = seen.get(key);
		if (already !== undefined) {
			aliases.set(reference, already);
			continue;
		}
		const definition = yield* Loader.load(target, origin, options);
		yield* note(definition.plugin, definition.version === undefined ? key : `${key}@${definition.version}`);
		// `package` configuration matches the registered module string. Keep its canonical name
		// and spec, or its local path, too, so a versioned entry can be configured without
		// repeating the version and a relative path stays anchored consistently.
		const names =
			target.kind === "local"
				? [target.path, ...(definition.name === undefined ? [] : [definition.name])]
				: [PluginSource.canonical(target), target.spec];
		remember(definition.plugin, [reference, ...names], {
			...(definition.version === undefined ? {} : { version: definition.version }),
			origin: {
				reference,
				...(definition.generation === undefined ? {} : { generation: definition.generation }),
				...(origin.file === undefined ? {} : { file: origin.file }),
			},
		});
		seen.set(key, definition.plugin.id);
	}

	return { plugins, aliases, versions, origins } satisfies Pool;
});

/** What the config pass could not satisfy */
export interface Selected {
	readonly selection: ReadonlyArray<Prepared>;
	/** References naming a module the pool does not hold. Reported, never fetched. */
	readonly missing: ReadonlyArray<string>;
}

/**
 * The **config pass**: pure data over modules that are already loaded, run at every exchange.
 *
 * An array entry is a **module** — a definition object, a path, a `file:` URL, or a package
 * spec. It takes the position it is written at, so naming a module again moves it.
 *
 * An object entry is **configuration** for a plugin an earlier entry (or the built-in list)
 * already selected, addressed by its ID (`plugin`) or the module string (`package`) that selected
 * it. It never loads, installs or reorders anything, and a name matching nothing in the selection
 * is ignored rather than failing the boot — a typo costs a debug line, never a fetch.
 *
 * Nothing here touches the disk, which is the whole point of the split: an `options` edit, an
 * `enabled` flip or a reordering applies at the next exchange without importing anything.
 */
export const select = Effect.fn("PluginCatalog.select")(function* (references: ReadonlyArray<PluginRef>, pool: Pool) {
	const operations = new Map<string, { enabled: boolean; index: number; options: PluginOptions }>();
	const missing: string[] = [];
	const choose = (id: string, index: number) =>
		operations.set(id, { enabled: true, index, options: operations.get(id)?.options ?? {} });

	for (const [index, reference] of references.entries()) {
		if (isPatch(reference)) {
			// TODO(sanchitrk): should we do some schema validation of sorts? - this feels hacky
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
				return yield* Loader.definitionFailure(origin, new Error(`plugin entry ${invalid}`));
			}
			const id = reference.plugin === undefined ? pool.aliases.get(reference.package) : reference.plugin;
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
				index: operation.index,
				// The block is opaque, so the last entry owns it whole rather than merging into
				// values the harness cannot interpret.
				options: reference.options ?? operation.options,
			});
			continue;
		}

		if (typeof reference !== "string") {
			const declared = Predicate.hasProperty(reference, "id") ? reference.id : undefined;
			if (typeof declared === "string" && pool.plugins.has(declared)) choose(declared, index);
			continue;
		}
		const id = pool.aliases.get(reference);
		// The one case the pass cannot satisfy, which is what makes drift free to report: the
		// entry is there, the module is not, and nothing here will fetch it.
		if (id === undefined) missing.push(reference);
		else choose(id, index);
	}

	const selection: Array<Prepared & { readonly index: number }> = [];
	for (const [id, operation] of operations) {
		if (!operation.enabled) continue;
		const plugin = pool.plugins.get(id);
		if (plugin !== undefined) {
			selection.push({ plugin, options: Object.freeze(operation.options), index: operation.index });
		}
	}
	// Domain first, then where the entry was written. Comparing the index explicitly rather than
	// leaning on a stable sort keeps the second half of the rule visible: composition inside one
	// domain -- a plugin patching another's tool, or appending to the prompt it rendered -- still
	// depends on the order those entries were written in.
	selection.sort((a, b) => rank(a.plugin.kind) - rank(b.plugin.kind) || a.index - b.index);
	return {
		selection: Object.freeze(selection.map(({ plugin, options }) => ({ plugin, options }) satisfies Prepared)),
		missing,
	} satisfies Selected;
});

/**
 * The exchange-boundary check: has the store moved under this pool?
 *
 * Every exchange already re-reads every settings layer from disk, and the config pass already
 * walks those entries against the loaded set. Two things can be settled right there, and they are
 * the same question asked twice:
 *
 * 1. a settings entry names a module that is not loaded, and the store holds it -- or it is loaded
 *    from another file's artifact than the one that owns it in this view, and the store holds
 *    the owner's;
 * 2. a loaded module is not the newest generation the store has.
 *
 * The second is what makes `plugin update` finish. Without it the question is "is this entry
 * loaded?", the answer after an update is still yes, and the bytes just fetched sit on disk until
 * something else forces an import.
 *
 * Returns the new pool, or nothing when nothing moved -- which is the common case, and costs one
 * store lookup per filed module.
 *
 * **This is not a watcher.** Nothing polls and no fiber exists; it is the observation that we were
 * already paying for the I/O that would tell us, and discarding the answer. Three bounds keep it
 * safe: the store only and never the network, so an exchange cannot block on a registry;
 * resolve-only, so it cannot install; and once, at the top of a snapshot, so an exchange already
 * running is unaffected.
 */
export const follow = Effect.fn("PluginCatalog.follow")(function* (
	references: ReadonlyArray<PluginRef>,
	pool: Pool,
	/**
	 * `install` is required and must be resolve-only. Making it non-optional is how "an exchange
	 * follows the store, it does not fill it" becomes a fact of the signature rather than a rule
	 * someone has to remember: the default installer fetches, and there is no way to reach it here.
	 */
	options: Options & { readonly install: NonNullable<Options["install"]> },
	/**
	 * Whether a reference's bytes are already on this machine, and at which generation.
	 *
	 * A local path answers yes with no generation: it is on disk by definition, and it is never
	 * filed, so nothing can supersede it. That is the difference between "can be loaded now" and
	 * "has moved" -- a local plugin is the first and never the second, which is why `reload`
	 * exists and covers only it.
	 *
	 * `from` is the `.npmrc` anchor the lookup computes the store key under: the project that
	 * declared the reference, so an exchange answers about the same artifact `plugin install`
	 * filed rather than the one the server's own directory would name.
	 */
	filed: (reference: string, from: string) => Effect.Effect<Option.Option<{ readonly generation?: number }>>,
) {
	let moved = false;

	for (const reference of references) {
		if (typeof reference !== "string") continue;
		const owner = options.declared?.get(reference);
		const from = Loader.anchor(owner, options.hostDir);
		const id = pool.aliases.get(reference);
		if (id !== undefined) {
			// Loaded -- but from the file that owns it here? A pool starts as a copy of the
			// process view, where the user file owns a spec a project may declare again beside
			// its own `.npmrc`. That owner names a different artifact, and it has moved in when
			// its bytes are on disk; until then the loaded build keeps serving.
			const origin = pool.origins.get(id);
			if (owner === undefined || origin?.reference !== reference) continue;
			if (Loader.anchor(origin.file, options.hostDir) === from) continue;
		}
		// Otherwise configured but not loaded. Reported by `select` either way; acted on only
		// when the bytes are already here -- which covers a package the store holds and a local
		// path that exists, and excludes anything that would have to be fetched.
		if (Option.isSome(yield* filed(reference, from))) {
			moved = true;
			break;
		}
	}

	if (!moved) {
		for (const origin of pool.origins.values()) {
			if (origin.generation === undefined) continue;
			const current = yield* filed(origin.reference, Loader.anchor(origin.file, options.hostDir));
			if (
				Option.isSome(current) &&
				current.value.generation !== undefined &&
				current.value.generation > origin.generation
			) {
				moved = true;
				break;
			}
		}
	}

	if (!moved) return Option.none<Pool>();
	// The pool belongs to a view -- the process, or one project -- shared by all of its sessions,
	// while `references` belongs to one session. Rebuilding from only that session would evict
	// modules its neighbours loaded. Origins are the view's reference set accumulated so far;
	// `load` deduplicates unchanged modules by their resolved key.
	// Retained origins come first so the current session's explicit reference wins when two specs
	// declare the same plugin ID (for example `pkg@1` followed by `pkg@2`).
	//
	// A retained origin's source may have vanished since it loaded -- a file deleted, a store
	// entry removed. It is nobody's declaration now, so it drops out of the pool with a warning
	// rather than failing the exchange for plugins nothing was wrong with. A reference the
	// session itself still configures stays strict: the drift check above covered it, and `load`
	// still fails on it.
	const retained: Origin[] = [];
	for (const origin of pool.origins.values()) {
		if (
			references.includes(origin.reference) ||
			Option.isSome(yield* filed(origin.reference, Loader.anchor(origin.file, options.hostDir)))
		) {
			retained.push(origin);
			continue;
		}
		yield* Effect.logWarning(`plugin ${origin.reference} no longer resolves; it is dropped from the loaded set`);
	}
	const accumulated = [...Array.from(retained, (origin) => origin.reference), ...references];
	// A retained module keeps its declaring file -- it is what the union of `references` does not
	// know. The session's own declarations win where both name one reference, because the entry
	// it just wrote is the anchor its `plugin install` used.
	const known = new Map<string, string>();
	for (const origin of retained) if (origin.file !== undefined) known.set(origin.reference, origin.file);
	for (const [reference, file] of options.declared ?? new Map<string, string>()) known.set(reference, file);
	// A full load pass, which is cheap for everything that did not move: an unchanged module
	// resolves to the same URL, and the module registry hands back the instance it already has
	// without re-evaluating it. Only a new generation is a new URL, and only that is re-imported.
	return Option.some(yield* load(accumulated, { ...options, declared: known }));
});

/** Both passes, for a caller that wants the selection and has no reason to hold the pool. */
export const prepare = Effect.fn("PluginCatalog.prepare")(function* (
	references: ReadonlyArray<PluginRef>,
	options: Options,
) {
	const pool = yield* load(references, options);
	return (yield* select(references, pool)).selection;
});

export { emptyPool };
