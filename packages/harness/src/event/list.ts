import { Schema } from "effect";
import { DateTimeUtcFromMillis, NonNegativeInt } from "../schema.ts";
import { SessionMessageSchema } from "../session/message/schema.ts";
import { PromptSchema } from "../session/prompt/schema.ts";
import { SessionSchema } from "../session/schema.ts";
import { EventSchema } from "./schema.ts";

const baseOptions = {
	timestamp: DateTimeUtcFromMillis,
	sessionId: SessionSchema.ID,
};
const durableOptions = {
	durable: {
		aggregate: "sessionId",
		version: 1,
	},
} as const;

const PromptFields = {
	...baseOptions,
	messageId: SessionMessageSchema.ID,
	prompt: PromptSchema.Prompt,
	delivery: PromptSchema.Delivery,
};

// confirmed
export const PromptAdmitted = EventSchema.define({
	type: "session.next.prompt.admitted",
	...durableOptions,
	schema: PromptFields,
});
export type PromptAdmitted = typeof PromptAdmitted.Type;

// confirmed
export const Prompted = EventSchema.define({
	type: "session.next.prompt.promoted",
	...durableOptions,
	schema: PromptFields,
});
export type Prompted = typeof Prompted.Type;

/*
 * The aikit response events.
 *
 * Only the two terminals are durable. Every aikit event already carries a
 * complete assistant message, so the terminal one contains everything the
 * response produced -- including whatever was generated before an abort, since
 * aikit reports that as `error` with the accumulated output. Persisting the
 * boundaries in between would buy nothing and cost the invariant: an entry
 * written mid-stream can be left non-terminal by a crash, and `Context.assemble`
 * would then replay a truncated answer to the model as though it were complete.
 *
 * None of these payloads carries aikit's `partial`. It is one mutable object
 * that aikit rewrites in place and pushes by reference into a queue, so by the
 * time a consumer reads a queued event the value has moved on. Only the stable
 * scalars each event computes at push time are safe to carry.
 */
const LLMFields = {
	...baseOptions,
	/*
	 * aikit's own message id, carried verbatim. `SessionMessageSchema.ID` is
	 * unprefixed precisely so this needs no translation: the id in the event, the
	 * id inside the terminal message, and the assistant entry's id are all one
	 * value, which is what the codec's `entry.id === message.messageId` rule
	 * wants.
	 */
	messageId: SessionMessageSchema.ID,
};

const LLMPartFields = {
	...LLMFields,
	partIndex: NonNegativeInt,
};

export const LLMStarted = EventSchema.define({
	type: "session.llm.started",
	schema: LLMFields,
});
export type LLMStarted = typeof LLMStarted.Type;

export const LLMTextStart = EventSchema.define({
	type: "session.llm.text.start",
	schema: LLMPartFields,
});
export type LLMTextStart = typeof LLMTextStart.Type;

export const LLMTextDelta = EventSchema.define({
	type: "session.llm.text.delta",
	schema: { ...LLMPartFields, delta: Schema.String },
});
export type LLMTextDelta = typeof LLMTextDelta.Type;

export const LLMTextEnd = EventSchema.define({
	type: "session.llm.text.end",
	schema: { ...LLMPartFields, content: Schema.String },
});
export type LLMTextEnd = typeof LLMTextEnd.Type;

export const LLMThinkingStart = EventSchema.define({
	type: "session.llm.thinking.start",
	schema: LLMPartFields,
});
export type LLMThinkingStart = typeof LLMThinkingStart.Type;

export const LLMThinkingDelta = EventSchema.define({
	type: "session.llm.thinking.delta",
	schema: { ...LLMPartFields, delta: Schema.String },
});
export type LLMThinkingDelta = typeof LLMThinkingDelta.Type;

export const LLMThinkingEnd = EventSchema.define({
	type: "session.llm.thinking.end",
	schema: { ...LLMPartFields, content: Schema.String },
});
export type LLMThinkingEnd = typeof LLMThinkingEnd.Type;

/** aikit `done`: the response completed and `message` is authoritative. */
export const LLMEnded = EventSchema.define({
	type: "session.llm.ended",
	...durableOptions,
	schema: {
		...LLMFields,
		reason: Schema.Literals(["stop", "length", "toolUse"]),
		message: EventSchema.AikitAssistantMessage,
	},
});
export type LLMEnded = typeof LLMEnded.Type;

/**
 * aikit `error`: the response failed or was aborted. aikit names this payload
 * `error`, but it is a complete assistant message carrying everything generated
 * before the failure, so it projects exactly like a successful one.
 */
export const LLMFailed = EventSchema.define({
	type: "session.llm.failed",
	...durableOptions,
	schema: {
		...LLMFields,
		reason: Schema.Literals(["aborted", "error"]),
		message: EventSchema.AikitAssistantMessage,
	},
});
export type LLMFailed = typeof LLMFailed.Type;

/**
 * First event in a forked session's log. The aggregate is the *new* session, so
 * this lands at `baseSeq + 1`: the fork seeds the new aggregate's sequence to
 * the fork point, reserving [0..baseSeq] for the copied entries. Recording it
 * makes the seeded range auditable from the log itself, not only from
 * `session.parentId`.
 */
export const SessionForked = EventSchema.define({
	type: "session.next.forked",
	...durableOptions,
	schema: {
		...baseOptions,
		sourceSessionId: SessionSchema.ID,
		/** Entry in the source session the copy stops at (its leaf, for a clone). */
		sourceEntryId: Schema.String,
		/** Highest sequence carried over; the new log starts above it. */
		baseSeq: NonNegativeInt,
	},
});
export type SessionForked = typeof SessionForked.Type;

export const DurableDefinitions = EventSchema.inventory(PromptAdmitted, Prompted, SessionForked, LLMEnded, LLMFailed);

export * as EventList from "./list.ts";
