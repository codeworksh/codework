import { Model } from "@codeworksh/aikit";
import { Schema } from "effect";
import { NonNegativeCost, NonNegativeInt, optional } from "../schema.ts";

// Session identity lives in `@codeworksh/plugin`: it is on every plugin context and every
// tool call, so the brand a plugin holds has to be the one the harness mints.
export { SessionID as ID } from "@codeworksh/plugin/ids";

export const IDFromDb = Schema.String.pipe(Schema.brand("Session.ID"));

/** The title of a session created without one; its first prompt replaces it. */
export const DEFAULT_TITLE = "Session";
export const TITLE_MAX_LENGTH = 48;

/**
 * A title from a prompt: its first non-empty line, whitespace collapsed, cut on a word boundary
 * to {@link TITLE_MAX_LENGTH} characters including the ellipsis. `undefined` for a blank prompt.
 */
export const titleFrom = (text: string): string | undefined => {
	const line = text
		.split("\n")
		.map((one) => one.replace(/\s+/g, " ").trim())
		.find((one) => one.length > 0);
	if (line === undefined || line.length <= TITLE_MAX_LENGTH) return line;
	const cut = line.slice(0, TITLE_MAX_LENGTH - 1);
	const space = cut.lastIndexOf(" ");
	return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

export const ThinkingLevel = Schema.Literals(Object.values(Model.ThinkingLevelEnum));

/**
 * The model and thinking level chosen for a session, over its settings. Every key is optional:
 * an absent one means the session follows its settings. `session.config.changed` carries only the
 * keys it changes, and the `session.config` column holds them merged.
 */
export const Config = Schema.Struct({
	model: optional(Schema.Struct({ provider: Schema.String, id: Schema.String })),
	thinkingLevel: optional(ThinkingLevel),
});
export type Config = typeof Config.Type;

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
