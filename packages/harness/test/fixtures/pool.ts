import { Effect, Option, Ref } from "effect";
import type { PluginRef, Pool } from "../../src/plugin/catalog.ts";
import type { Plugin } from "../../src/plugin/plugin.ts";

/**
 * A loaded pool holding exactly these plugins, and references that select all of them in order.
 *
 * `State.layer` takes the two separately because they refresh at different rates -- the pool at
 * boot and at reload, the references at every exchange. A test that only wants "run these plugins"
 * needs neither distinction, so this collapses them.
 */
export const pooled = (plugins: ReadonlyArray<Plugin>) => {
	const pool: Pool = {
		plugins: new Map(plugins.map((plugin) => [plugin.id, plugin])),
		aliases: new Map(plugins.map((plugin) => [plugin.id, plugin.id])),
		versions: new Map(),
		origins: new Map(),
	};
	const references: ReadonlyArray<PluginRef> = plugins.map((plugin) => plugin.id);
	return {
		ref: Ref.makeUnsafe(pool),
		references: () => references,
		// No store behind these plugins, so nothing can move under them, and a reload has nothing
		// to re-read.
		follow: (): Effect.Effect<Option.Option<Pool>> => Effect.succeedNone,
		rebuild: (): Effect.Effect<Pool> => Effect.succeed(pool),
	};
};
