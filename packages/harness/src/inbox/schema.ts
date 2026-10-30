import { Schema } from "effect";
import { DateTimeUtcFromMillis, NonNegativeInt, optional } from "../schema.ts";
import { Delivery, Prompt } from "../session/prompt/schema.ts";
import { SessionSchema } from "../session/schema.ts";
import { SessionMessageSchema } from "../session/message/schema.ts";
import { ThreadSchema } from "../thread/schema.ts";

export const Admitted = Schema.Struct({
	admittedSeq: NonNegativeInt,
	id: SessionMessageSchema.ID,
	sessionId: SessionSchema.ID,
	threadId: ThreadSchema.ID,
	prompt: Prompt,
	delivery: Delivery,
	timeCreated: DateTimeUtcFromMillis,
	promotedSeq: NonNegativeInt.pipe(optional),
	cancelledSeq: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "Inbox.Admitted" });
export interface Admitted extends Schema.Schema.Type<typeof Admitted> {}
