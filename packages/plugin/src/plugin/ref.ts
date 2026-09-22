import type { Plugin } from "./plugin.ts";

/**
 * How a plugin is named in a `plugins` array, and what the harness does with each shape.
 *
 * The array is the whole configuration surface: an entry either *selects* a module or
 * *configures* one something else already selected. Nothing else is required of a plugin author,
 * which is why the shapes live in this package rather than in the loader that consumes them.
 */

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
