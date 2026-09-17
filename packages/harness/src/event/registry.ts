import { Context, Effect, Layer, Schema } from "effect";
import type { Plugin } from "../plugin/plugin.ts";
import { EventList } from "./list.ts";
import { EventSchema } from "./schema.ts";

/**
 * Every event definition this harness knows: the kernel's, plus whatever the
 * configured plugins registered. Built once at boot, because a definition that
 * arrives after the first publish cannot be validated against the ones already
 * in flight.
 */
export interface Interface {
	readonly definitions: ReadonlyArray<EventSchema.Definition>;
	/** The latest definition for a type, or `undefined` when nothing declares it. */
	readonly get: (type: string) => EventSchema.Definition | undefined;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/event/registry/Service") {}

export class EventRegistrationError extends Schema.TaggedError<EventRegistrationError>()("EventRegistrationError", {
	pluginId: Schema.String,
	type: Schema.String,
	reason: Schema.String,
}) {}

/** Plugin types are namespaced, which makes a collision with anything else structurally impossible. */
const namespace = (pluginId: string) => `plugin.${pluginId}.`;

const kernel = new Set<string>(EventList.Definitions.map((definition) => definition.type));

/**
 * Collects plugin event definitions into one set with the kernel's.
 *
 * Every rule fails the boot rather than resolving silently: a plugin that
 * shadows a kernel type or another plugin has a bug, and first-loaded-wins would
 * hide it behind plugin ordering.
 */
export const flatten = Effect.fn("EventRegistry.flatten")(function* (plugins: ReadonlyArray<Plugin>) {
	const registered = new Map<string, string>();
	const definitions: EventSchema.Definition[] = [];
	for (const plugin of plugins) {
		const prefix = namespace(plugin.id);
		for (const definition of plugin.events ?? []) {
			if (kernel.has(definition.type))
				return yield* new EventRegistrationError({
					pluginId: plugin.id,
					type: definition.type,
					reason: "this is a kernel event type",
				});
			const owner = registered.get(definition.type);
			if (owner !== undefined)
				return yield* new EventRegistrationError({
					pluginId: plugin.id,
					type: definition.type,
					reason: `plugin ${owner} already registers this type`,
				});
			if (!definition.type.startsWith(prefix))
				return yield* new EventRegistrationError({
					pluginId: plugin.id,
					type: definition.type,
					reason: `plugin event types must start with "${prefix}"`,
				});
			registered.set(definition.type, plugin.id);
			definitions.push(definition);
		}
	}
	return [...EventList.Definitions, ...definitions] as ReadonlyArray<EventSchema.Definition>;
});

export const layer = (definitions: ReadonlyArray<EventSchema.Definition> = EventList.Definitions) =>
	Layer.sync(Service, () => {
		const latest = EventSchema.latest(definitions);
		return Service.of({ definitions, get: (type) => latest.get(type) });
	});

export * as EventRegistry from "./registry.ts";
