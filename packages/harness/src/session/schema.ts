import { Schema } from "effect";
import { uuidv7 } from "uuidv7";
import { NonNegativeCost, NonNegativeInt, withStatics } from "../schema.ts";

// Session identity. Branded so a session ID is not interchangeable with an
// entry, part, or workspace ID at the type level — service signatures take
// `SessionSchema.ID`, never a bare `string`.
//
// `create` mints a new one; `ascending` adopts an ID that came from outside
// (a persisted row, a request payload) and rejects a foreign prefix rather
// than branding it silently. uuidv7 keeps IDs lexicographically sortable by
// creation time, so `ORDER BY id` is `ORDER BY created`.
export const ID = Schema.String.check(Schema.isStartsWith("ses")).pipe(
	Schema.brand("Session.ID"),
	withStatics((schema) => ({
		ascending: (id?: string) => {
			if (!id) return schema.make("ses_" + uuidv7());
			if (!id.startsWith("ses")) throw new Error(`ID ${id} does not start with ses`);
			return schema.make(id);
		},
		create: () => schema.make("ses_" + uuidv7()),
	})),
);
export type ID = typeof ID.Type;

export const IDFromDb = Schema.String.pipe(Schema.brand("Session.ID"));

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
