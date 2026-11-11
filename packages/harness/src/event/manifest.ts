// This shall pull the durable event definition
// before this we need to have event definition that needs to be registered.

import { Schema as EffectSchema } from "effect";
import * as EventList from "./list.ts";
import { EventSchema } from "./schema.ts";

const Durable = EventSchema.durable([...EventList.DurableDefinitions]);
const Schema = EffectSchema.Union([...EventList.DurableDefinitions], { mode: "oneOf" }).pipe(
	EffectSchema.toTaggedUnion("type"),
);

export const Manifest = {
	definitions: Durable,
	schema: Schema,
} as const;
