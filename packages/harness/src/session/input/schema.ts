import { Schema } from "effect";
import {
  DateTimeUtcFromMillis,
  NonNegativeInt,
  optional,
} from "../../schema.ts";
import { Delivery, Prompt } from "../prompt/schema.ts";
import { SessionSchema } from "../schema.ts";
import { SessionMessageSchema } from "../message/schema.ts";

export const Admitted = Schema.Struct({
  admittedSeq: NonNegativeInt,
  id: SessionMessageSchema.ID,
  sessionId: SessionSchema.ID,
  prompt: Prompt,
  delivery: Delivery,
  timeCreated: DateTimeUtcFromMillis,
  promotedSeq: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "SessionInput.Admitted" });
export interface Admitted extends Schema.Schema.Type<typeof Admitted> {}
