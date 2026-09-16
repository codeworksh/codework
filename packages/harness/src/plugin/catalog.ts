import { Effect, Predicate } from "effect";
import { merge } from "../settings/merge.ts";
import * as Loader from "./loader.ts";
import type { Plugin } from "./plugin.ts";

/** Opaque to the harness: a plugin reads and validates its own block. */
export type PluginOptions = { readonly [key: string]: unknown };
/** A definition, or a reference to one: an ID, a path, or a package spec. */
export type PluginSpec = Plugin | string;
export interface PluginEntry {
	readonly plugin: PluginSpec;
	/**
	 * `false` drops a plugin another entry selected. Only an ID can be turned off —
	 * a path or a package spec would have to be installed and imported to learn which
	 * plugin it names, and removing the entry that added it says the same thing.
	 */
	readonly enabled?: boolean | undefined;
	readonly options?: PluginOptions | undefined;
}
export type PluginRef = PluginSpec | PluginEntry;
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

/** A definition carries `setup`; only the configured long form carries `plugin`. */
const isEntry = (reference: PluginRef): reference is PluginEntry =>
	Predicate.isObject(reference) && !Predicate.isFunction(reference) && "plugin" in reference;

/**
 * Resolve every reference to the ordered selection the harness runs.
 *
 * A plugin may be named more than once — the built-in list, then a settings entry
 * configuring or disabling it. Every mention updates that plugin's `enabled` flag and merges
 * its `options`. Position is owned by its last *bare* mention, so re-listing an ID moves it
 * later; an entry carrying `options` patches it where it already is, because configuring
 * `codework.tool.bash` must not move it past the prompt plugin that indexes its tools.
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
	const operations = new Map<string, { enabled: boolean; origin: Loader.Origin; options: PluginOptions }>();
	const loaded = new Map<string, Loader.Loaded>();
	for (const [index, reference] of references.entries()) {
		const entry = isEntry(reference) ? reference : { plugin: reference };
		const spec = entry.plugin;
		// `spec` must stay a string here: an unvalidated object may carry no `id` at all, and
		// `PreparationError.reference` would then throw instead of reporting the bad entry.
		const declared = typeof spec === "string" ? spec : (spec as { id?: unknown }).id;
		const origin = { index, reference: typeof declared === "string" ? declared : `<plugin object #${index}>` };
		const enabled = entry.enabled ?? true;
		const record = (id: string) => {
			const previous = operations.get(id);
			operations.set(id, {
				enabled,
				origin: previous === undefined || entry.options === undefined ? origin : previous.origin,
				options: merge<PluginOptions>(previous?.options ?? {}, entry.options),
			});
		};
		if (typeof spec !== "string") {
			const plugin = yield* Loader.validate(spec, origin);
			yield* note(plugin, "a supplied object");
			catalog.add(plugin, "object");
			record(plugin.id);
			continue;
		}
		const source = yield* Effect.try({
			try: () => Loader.classify(spec, hostCwd),
			catch: (cause) => Loader.failure(origin, "source", cause),
		});
		if (source.kind === "id") {
			record(source.id);
			continue;
		}
		if (!enabled) {
			return yield* Loader.failure(
				origin,
				"source",
				new Error(`"enabled": false needs a plugin ID; remove the entry to drop ${spec}`),
			);
		}
		const key = source.kind === "package" ? source.request.spec : source.path;
		const definition = loaded.get(key) ?? (yield* Loader.load(source, origin, options));
		loaded.set(key, definition);
		yield* note(definition.plugin, definition.version === undefined ? key : `${key}@${definition.version}`);
		catalog.add(definition.plugin, definition.source, definition.version);
		record(definition.plugin.id);
	}
	const selection: Prepared[] = [];
	for (const [id, operation] of [...operations].sort((a, b) => a[1].origin.index - b[1].origin.index)) {
		// Turning off a plugin nothing installed is a no-op, not a failure: a selection may
		// disable a built-in it does not otherwise care whether this build ships.
		if (!operation.enabled) continue;
		const plugin = catalog.get(id);
		if (!plugin) return yield* Loader.failure(operation.origin, "resolve", new Error(`Unknown plugin ID: ${id}`), id);
		selection.push({ plugin, options: Object.freeze(operation.options) });
	}
	return Object.freeze(selection);
});
