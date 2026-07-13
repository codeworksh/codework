import { Schema } from "effect";

// Harness-owned shape of the billed usage inside a persisted assistant
// envelope. This is data-structure integrity only — business validation
// belongs to the Context Manager, a layer above. Stricter than the wire:
// counts and costs must be non-negative so bad producer data fails the
// append instead of poisoning the session aggregates.
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeCost = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

// Shared persistence-boundary codecs. Append validates before writing; fork
// decodes again because legacy/imported rows may predate that validation.
export const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));

export const MessageEnvelopeIdentity = Schema.fromJsonString(
	Schema.Struct({
		messageId: Schema.String,
	}),
);

// NOTE: modify this if schema changes
export const CompactionData = Schema.fromJsonString(
	Schema.Struct({
		summary: Schema.String,
		// null explicitly means the summary replaces all preceding history.
		firstKeptEntryId: Schema.NullOr(Schema.String),
		tokensBefore: NonNegativeInt,
	}),
);
export type CompactionData = typeof CompactionData.Type;

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
