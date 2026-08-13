import { Schema } from "effect";
import { DateTimeUtcFromMillis, NonNegativeInt } from "../schema.ts";
import { EventSchema } from "./schema.ts";
import { SessionSchema } from "../session/schema.ts";
import { SessionMessageSchema } from "../session/message/schema.ts";
import { PromptSchema } from "../session/prompt/schema.ts";

const Base = {
  timestamp: DateTimeUtcFromMillis,
  sessionId: SessionSchema.ID,
};

const PromptFields = {
  ...Base,
  messageId: SessionMessageSchema.ID,
  prompt: PromptSchema.Prompt,
  delivery: PromptSchema.Delivery,
};

const options = {
  durable: {
    aggregate: "sessionId",
    version: 1,
  },
} as const;

export const PromptAdmitted = EventSchema.define({
  type: "session.next.prompt.admitted",
  ...options,
  schema: PromptFields,
});
export type PromptAdmitted = typeof PromptAdmitted.Type;

export const Prompted = EventSchema.define({
  type: "session.next.prompt.promoted",
  ...options,
  schema: PromptFields,
});
export type Prompted = typeof Prompted.Type;

/**
 * First event in a forked session's log. The aggregate is the *new* session, so
 * this lands at `baseSeq + 1`: the fork seeds the new aggregate's sequence to
 * the fork point, reserving [0..baseSeq] for the copied entries. Recording it
 * makes the seeded range auditable from the log itself, not only from
 * `session.parentId`.
 */
export const SessionForked = EventSchema.define({
  type: "session.next.forked",
  ...options,
  schema: {
    ...Base,
    sourceSessionId: SessionSchema.ID,
    /** Entry in the source session the copy stops at (its leaf, for a clone). */
    sourceEntryId: Schema.String,
    /** Highest sequence carried over; the new log starts above it. */
    baseSeq: NonNegativeInt,
  },
});
export type SessionForked = typeof SessionForked.Type;

export const DurableDefinitions = EventSchema.inventory(
  PromptAdmitted,
  Prompted,
  SessionForked,
);


export * as EventList from "./list.ts";