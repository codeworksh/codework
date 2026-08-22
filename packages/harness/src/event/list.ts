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

const LLMFields = {
	...baseOptions,
	messageId: SessionMessageSchema.ID,
};

const LLMPartFields = {
	...LLMFields,
	partIndex: NonNegativeInt,
};

export const TurnAbortCause = Schema.Union([
	Schema.TaggedStruct("interrupted", {}),
	Schema.TaggedStruct("error", { message: Schema.String }),
	Schema.TaggedStruct("deferred", { message: Schema.String }),
]);
export type TurnAbortCause = typeof TurnAbortCause.Type;

export const TurnStarted = EventSchema.define({
	type: "session.turn.started",
	schema: baseOptions,
});
export type TurnStarted = typeof TurnStarted.Type;

export const TurnEnded = EventSchema.define({
	type: "session.turn.ended",
	...durableOptions,
	schema: LLMFields,
});
export type TurnEnded = typeof TurnEnded.Type;

export const TurnAborted = EventSchema.define({
	type: "session.turn.aborted",
	schema: { ...baseOptions, cause: TurnAbortCause },
});
export type TurnAborted = typeof TurnAborted.Type;

/** Durable insertion of the request's draft assistant placeholder. */
export const LLMStarted = EventSchema.define({
	type: "session.llm.started",
	...durableOptions,
	schema: { ...LLMFields, message: EventSchema.AikitAssistantMessage },
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

/** aikit `done`: replace the LLMStarted payload in place; state stays draft. */
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

/** Abort the whole draft and discard every part. */
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

export const ToolStarted = EventSchema.define({
	type: "session.tool.started",
	schema: { ...LLMFields, callID: Schema.String, name: Schema.String },
});
export type ToolStarted = typeof ToolStarted.Type;

export const ToolProgress = EventSchema.define({
	type: "session.tool.progress",
	schema: { ...LLMFields, callID: Schema.String, partial: Schema.Unknown },
});
export type ToolProgress = typeof ToolProgress.Type;

export const ToolSettled = EventSchema.define({
	type: "session.tool.settled",
	...durableOptions,
	schema: {
		...LLMFields,
		callID: Schema.String,
		part: EventSchema.AikitToolCallTerminalPart,
	},
});
export type ToolSettled = typeof ToolSettled.Type;

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

export const DurableDefinitions = EventSchema.inventory(
	PromptAdmitted,
	Prompted,
	SessionForked,
	TurnEnded,
	LLMStarted,
	LLMEnded,
	LLMFailed,
	ToolSettled,
);

export * as EventList from "./list.ts";
