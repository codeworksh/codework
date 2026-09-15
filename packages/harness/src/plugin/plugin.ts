import type { Effect } from "effect";
import type { EventSchema } from "../event/schema.ts";
import type { Location } from "../location/location.ts";
import type { SandboxIO } from "../sandbox/io.ts";
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
	readonly setup: (ctx: SharedPluginContext) => void | Promise<void> | Effect.Effect<void, unknown, Mount>;
}

export const define = (plugin: Plugin): Plugin => plugin;
