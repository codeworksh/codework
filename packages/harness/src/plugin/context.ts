import type { Events } from "@codeworksh/plugin/plugin";
import { Effect } from "effect";
import { EventList } from "../event/list.ts";

/**
 * The plugin context contract lives in `@codeworksh/plugin`; what stays here is the harness's
 * enforcement of it -- the kernel event namespace a plugin may not publish into.
 */
export type { Config, Events, PromptResolver, SharedPluginContext } from "@codeworksh/plugin/plugin";

// Every kernel type, not just the durable ones: `EventRegistry.flatten` rejects
// these at boot, and this stays as the backstop for anything that reaches
// publish without going through registration.
const reserved = new Set<string>(EventList.Definitions.map((definition) => definition.type));
export const makeEvents = (events: Events): Events =>
	Object.freeze<Events>({
		publish: (definition, data, options) =>
			reserved.has(definition.type)
				? Effect.die(new Error(`plugins cannot publish kernel journal event: ${definition.type}`))
				: events.publish(definition, data, options),
	});
