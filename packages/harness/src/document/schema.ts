import { Model } from "@codeworksh/aikit";
import { Schema } from "effect";
import { AbsolutePath, optional } from "../schema.ts";

export const ID = Schema.String.pipe(Schema.brand("Document.ID"));
export type ID = typeof ID.Type;

/** latest = only the newest value matters; rewindable = readable as of any seq. */
export const History = Schema.Literals(["latest", "rewindable"]);
export type History = typeof History.Type;

/** What a fork's new thread gets: the value at the cut, the value now, or nothing. */
export const Fork = Schema.Literals(["asOf", "current", "initial"]);
export type Fork = typeof Fork.Type;

/**
 * A document kind, declared once in code. Storage keeps scope and policy on the row, so a document
 * survives when its definition is gone.
 */
export interface Definition {
	readonly kind: string;
	readonly version: number;
	readonly scope: "session" | "thread";
	/** Thread scope only. */
	readonly history?: History;
	/** Thread scope only; `asOf` needs `rewindable`. */
	readonly fork?: Fork;
}

export const ThinkingLevel = Schema.Literals(Object.values(Model.ThinkingLevelEnum));

export const ModelRef = Schema.Struct({ provider: Schema.String, id: Schema.String });

/** Physical boundary of a thread: which space, and the cwd inside it. Set together, never one alone. */
export const Placement = Schema.Struct({ spaceId: Schema.String, directory: AbsolutePath });
export type Placement = typeof Placement.Type;

export const ModelTools = Schema.Struct({
	add: optional(Schema.Array(Schema.String)),
	remove: optional(Schema.Array(Schema.String)),
});

/** Choices made for one thread; an unset field follows settings. */
export const Agent = Schema.Struct({
	model: optional(ModelRef),
	thinkingLevel: optional(ThinkingLevel),
	/** Deferred tools offered to the model (`add`) or withheld (`remove`). */
	modelTools: optional(ModelTools),
	/** Physical boundary override; absent = the session's. */
	placement: optional(Placement),
});
export type Agent = typeof Agent.Type;

/** A change to {@link Agent}: a given field replaces the stored one, `null` clears it, absent leaves it. */
export const AgentChange = Schema.Struct({
	model: optional(Schema.NullOr(ModelRef)),
	thinkingLevel: optional(Schema.NullOr(ThinkingLevel)),
	modelTools: optional(Schema.NullOr(ModelTools)),
	placement: optional(Schema.NullOr(Placement)),
});
export type AgentChange = typeof AgentChange.Type;

export const applyAgentChange = (current: Agent, change: AgentChange): Agent => {
	const next: Record<string, unknown> = { ...current };
	for (const [key, value] of Object.entries(change)) {
		if (value === undefined) continue;
		if (value === null) delete next[key];
		else next[key] = value;
	}
	return next as Agent;
};

/** Built in: created with every thread, replaces a session-wide configuration. */
export const agent: Definition = {
	kind: "agent",
	version: 1,
	scope: "thread",
	history: "rewindable",
	fork: "asOf",
};

export * as DocumentSchema from "./schema.ts";
