import type { Model } from "@codeworksh/aikit";
import { Effect } from "effect";
import type { Event } from "../event/event.ts";
import { EventList } from "../event/list.ts";
import type { Location } from "../location/location.ts";
import type { SandboxIO } from "../sandbox/io.ts";
import type { SessionSchema } from "../session/schema.ts";
import type { Info } from "../settings/schema.ts";
import type { PluginRegistry } from "./registry.ts";

export type PromptResolver = (ctx: SharedPluginContext) => string | Promise<string>;
export interface Config {
	readonly promptCustom?: PromptResolver;
	readonly promptSystemAppend?: PromptResolver;
}
export interface Events {
	readonly publish: Event.Interface["publish"];
}
export interface SharedPluginContext {
	readonly sessionId: SessionSchema.ID;
	readonly sandbox: SandboxIO.Identity;
	readonly location: Location.Info;
	readonly settings: Info;
	readonly model: Model.Info;
	readonly config: Config;
	readonly events: Events;
	readonly plugin: PluginRegistry;
}

const reserved = new Set<string>(EventList.DurableDefinitions.map((definition) => definition.type));
export const makeEvents = (events: Events): Events =>
	Object.freeze<Events>({
		publish: (definition, data, options) =>
			reserved.has(definition.type)
				? Effect.die(new Error(`Plugins cannot publish kernel journal event: ${definition.type}`))
				: events.publish(definition, data, options),
	});
