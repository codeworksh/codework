import { Schema } from "effect";
import { NonNegativeCost, NonNegativeInt, optional } from "../schema.ts";

// Session identity lives in `@codeworksh/plugin`: it is on every plugin context and every
// tool call, so the brand a plugin holds has to be the one the harness mints.
export { SessionID as ID } from "@codeworksh/plugin/ids";

export const IDFromDb = Schema.String.pipe(Schema.brand("Session.ID"));

/**
 * Why an execution stopped. Supplied by whoever asked for the interruption --
 * a stop the user asked for and a stop the process imposed on shutdown are
 * different facts, and inspecting the cause cannot tell them apart.
 */
export const InterruptReason = Schema.Literals(["user", "shutdown"]);
export type InterruptReason = typeof InterruptReason.Type;

// Shared persistence-boundary codecs. Append validates before writing; fork
// decodes again because legacy/imported rows may predate that validation.
export const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));

export const MessageEnvelopeIdentity = Schema.fromJsonString(
	Schema.Struct({
		messageId: Schema.String,
	}),
);

// NOTE: modify this if schema changes for compaction
export const CompactionData = Schema.fromJsonString(
	Schema.Struct({
		summary: Schema.String,
		// null explicitly means the summary replaces all preceding history.
		firstKeptEntryId: Schema.NullOr(Schema.String),
		tokensBefore: NonNegativeInt,
	}),
);
export type CompactionData = typeof CompactionData.Type;

/** A tool as declared to the model (aikit `Tool`). Validated in full where it becomes a system message. */
export const ToolDeclaration = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	parameters: Schema.Unknown,
	constrainedSampling: optional(Schema.Unknown),
});

/** A change to the tools offered from one point of the transcript on, as a `system` entry stores it. */
export const ToolChanges = Schema.Struct({
	toolsAdded: Schema.Array(ToolDeclaration),
	toolsRemoved: Schema.Array(Schema.Struct({ name: Schema.String })),
	/** sha256 of the offered tool declarations after the change. */
	hash: Schema.String,
});
export type ToolChanges = typeof ToolChanges.Type;

export const SystemData = Schema.fromJsonString(ToolChanges);

// Harness-owned shape of the billed usage inside a persisted assistant envelope.
// This is data-structure integrity only — business validation
// belongs to the Context Manager, a layer above. Stricter than the wire:
// counts and costs must be non-negative so bad producer data fails the
// append instead of poisoning the session aggregates.
export const Usage = Schema.Struct({
	input: NonNegativeInt,
	output: NonNegativeInt,
	cacheRead: NonNegativeInt,
	cacheWrite: NonNegativeInt,
	totalTokens: NonNegativeInt,
	cost: Schema.Struct({
		input: NonNegativeCost,
		output: NonNegativeCost,
		cacheRead: NonNegativeCost,
		cacheWrite: NonNegativeCost,
		total: NonNegativeCost,
	}),
});
export type Usage = typeof Usage.Type;

// "JSON string whose object carries a conforming usage" as one codec;
// JSON.parse failures land in the same SchemaError channel as shape failures.
export const AssistantEnvelopeUsage = Schema.fromJsonString(Schema.Struct({ usage: Usage }));

export * as SessionSchema from "./schema.ts";
