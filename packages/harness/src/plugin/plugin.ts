/** The plugin definition contract. Defined in `@codeworksh/plugin`, which plugin authors install. */
import type { Plugin } from "@codeworksh/plugin/plugin";

export * from "@codeworksh/plugin/plugin";

/**
 * A built-in plugin. `whenDeferred` makes an `optIn` one turn on by itself in a turn with deferred
 * tools; a settings entry's `enabled` still decides. Not in the published contract: it reads only
 * on the reserved `codework.` namespace, which third-party plugins cannot use.
 */
export interface Builtin extends Plugin {
	readonly whenDeferred?: true;
}

export const whenDeferred = (plugin: Plugin): boolean =>
	plugin.id.startsWith("codework.") && "whenDeferred" in plugin && plugin.whenDeferred === true;
