// This shall pull the durable event definition
// before this we need to have event definition that needs to be registered.

import { Schema as EffectSchema } from "effect";
import { EventList } from "./list.ts";
import { EventSchema } from "./schema.ts";

export const Durable = EventSchema.durable([...EventList.DurableDefinitions]);
export const Schema = EffectSchema.Union([...EventList.DurableDefinitions], { mode: "oneOf" }).pipe(
	EffectSchema.toTaggedUnion("type"),
);

export const Manifest = {
	definitions: Durable,
	schema: Schema,
} as const;

export * as EventManifest from "./manifest.ts";
