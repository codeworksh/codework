// This shall pull the durable event definition
// before this we need to have event definition that needs to be registered.

import { EventSchema } from "./schema.ts";
import { EventList } from "./list.ts";

export const Durable = EventSchema.durable([...EventList.DurableDefinitions]);

export * as EventManifest from "./manifest.ts";
