import { Effect } from "effect";
import * as Loader from "./loader.ts";
import type { Plugin } from "./plugin.ts";

export type PluginRef = Plugin | string;
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
	const operations = new Map<string, { enabled: boolean; origin: Loader.Origin }>();
	const loaded = new Map<string, Loader.Loaded>();
	for (const [index, reference] of references.entries()) {
		// `reference` must stay a string: an unvalidated object may carry no `id` at all, and
		// `PreparationError.reference` would then throw instead of reporting the bad entry.
		const declared = typeof reference === "string" ? reference : (reference as { id?: unknown }).id;
		const origin = { index, reference: typeof declared === "string" ? declared : `<plugin object #${index}>` };
		if (typeof reference !== "string") {
			const plugin = yield* Loader.validate(reference, origin);
			yield* note(plugin, "a supplied object");
			catalog.add(plugin, "object");
			operations.set(plugin.id, { enabled: true, origin });
			continue;
		}
		const source = yield* Effect.try({
			try: () => Loader.classify(reference, hostCwd),
			catch: (cause) => Loader.failure(origin, "source", cause),
		});
		if (source.kind === "id" || source.kind === "disable") {
			operations.set(source.id, { enabled: source.kind === "id", origin });
			continue;
		}
		const key = source.kind === "package" ? source.request.spec : source.path;
		const definition = loaded.get(key) ?? (yield* Loader.load(source, origin, options));
		loaded.set(key, definition);
		yield* note(definition.plugin, definition.version === undefined ? key : `${key}@${definition.version}`);
		catalog.add(definition.plugin, definition.source, definition.version);
		operations.set(definition.plugin.id, { enabled: true, origin });
	}
	const plugins: Plugin[] = [];
	for (const [id, operation] of [...operations].sort((a, b) => a[1].origin.index - b[1].origin.index)) {
		if (!operation.enabled) continue;
		const plugin = catalog.get(id);
		if (!plugin) return yield* Loader.failure(operation.origin, "resolve", new Error(`Unknown plugin ID: ${id}`), id);
		plugins.push(plugin);
	}
	return Object.freeze(plugins);
});
