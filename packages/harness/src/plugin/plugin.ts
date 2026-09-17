import type { Effect } from "effect";
import type { EventSchema } from "../event/schema.ts";
import type { Location } from "../location/location.ts";
import type { SandboxIO } from "../sandbox/io.ts";
import type { PluginOptions } from "./catalog.ts";
import type { SharedPluginContext } from "./context.ts";

export type Mount = SandboxIO.Provides | Location.Service;
export interface Plugin {
	readonly id: string;
	/**
	 * Event definitions this plugin publishes. Declared rather than registered at
	 * runtime so they are known before the event system builds, and so a bad type
	 * fails the boot instead of the first publish. Types must be namespaced
	 * `plugin.<id>.*`.
	 */
	readonly events?: ReadonlyArray<EventSchema.Definition>;
	/**
	 * `options` is this plugin's own configuration block, `{}` when its entry carried none.
	 * Unvalidated: the harness never looks inside it, so a plugin checks whatever shape it
	 * documents. It is a second argument rather than a context field so `ctx` stays one object
	 * shared by every plugin in the exchange.
	 */
	readonly setup: (
		ctx: SharedPluginContext,
		options: PluginOptions,
	) => void | Promise<void> | Effect.Effect<void, unknown, Mount>;
}

export const define = (plugin: Plugin): Plugin => plugin;
