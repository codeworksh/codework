import type { Effect } from "effect";
import type { SharedPluginContext } from "./context.ts";
import type { Location } from "../location/location.ts";
import type { SandboxIO } from "../sandbox/io.ts";

export type Mount = SandboxIO.Provides | Location.Service;
export interface Plugin {
	readonly id: string;
	readonly setup: (ctx: SharedPluginContext) => void | Promise<void> | Effect.Effect<void, unknown, Mount>;
}

export const define = (plugin: Plugin): Plugin => plugin;
