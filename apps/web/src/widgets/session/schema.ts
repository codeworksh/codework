import { Delivery, HistoryEntry, ThinkingLevel } from "@codeworksh/widget/codework";
import { Schema } from "effect";

/*
 * What the Session view and backend agree on: the topics they use and the payloads on them. Both
 * halves import this file, so it stays free of React and the DOM.
 */

export const topics = {
	/** Requests: start following a session; answered once its snapshot is stored. */
	follow: "codework/session.follow",
	/** Requests: create a session and send its first prompt; answered with its id. */
	create: "codework/session.create",
	prompt: "codework/session.prompt",
	interrupt: "codework/session.interrupt",
	/** Requests: a window of a followed session's conversation, newest first back from `before`. */
	page: "codework/session.page",
	/** Updates to one session's conversation. */
	session: (id: string) => `codework/session/${id}`,
};

/** The kv key of a session's snapshot. */
export const snapshotKey = (id: string) => `session/${id}`;

export const Follow = Schema.Struct({ sessionId: Schema.String });

export const Prompt = Schema.Struct({
	sessionId: Schema.String,
	/** Chosen by the view: the id of the user message this prompt becomes. */
	messageId: Schema.String,
	text: Schema.String,
	delivery: Schema.optionalKey(Delivery),
});
export type Prompt = typeof Prompt.Type;

/** Where a new session works: a folder on the host, or a sandbox held only in memory. */
export const Place = Schema.Union([
	Schema.TaggedStruct("Folder", { path: Schema.String }),
	Schema.TaggedStruct("Memory", {}),
]);
export type Place = typeof Place.Type;

export const Create = Schema.Struct({
	place: Place,
	/** Chosen by the view: the id of the first user message. */
	messageId: Schema.String,
	text: Schema.String,
	/** The session's model; omitted leaves it to settings. */
	model: Schema.optionalKey(Schema.Struct({ provider: Schema.String, id: Schema.String })),
	/** How hard the model reasons; omitted leaves it to settings. */
	thinkingLevel: Schema.optionalKey(ThinkingLevel),
});
export type Create = typeof Create.Type;

/** The answer to a create request: the new session, or why there is none. */
export const Created = Schema.Union([
	Schema.TaggedStruct("Created", { sessionId: Schema.String }),
	Schema.TaggedStruct("Failed", { message: Schema.String }),
]);
export type Created = typeof Created.Type;

export const Interrupt = Schema.Struct({ sessionId: Schema.String });

export const Page = Schema.Struct({
	sessionId: Schema.String,
	/** The oldest message the view holds; omitted asks for the newest messages. */
	before: Schema.optionalKey(Schema.String),
	limit: Schema.Int,
});

/** The answer to every request: done, or why not. */
export const Reply = Schema.Union([
	Schema.TaggedStruct("Done", {}),
	Schema.TaggedStruct("Failed", { message: Schema.String }),
]);
export type Reply = typeof Reply.Type;

export const Info = Schema.Struct({
	title: Schema.String,
	project: Schema.optionalKey(Schema.Struct({ id: Schema.String, name: Schema.String })),
	model: Schema.optionalKey(Schema.Struct({ provider: Schema.String, id: Schema.String })),
	/** Last activity, epoch milliseconds. */
	updated: Schema.Number,
});
export type Info = typeof Info.Type;

/** A session as the backend keeps it in kv and a view loads before subscribing. */
export const Snapshot = Schema.Struct({
	info: Info,
	messages: Schema.Array(HistoryEntry),
	/** The CodeWork log position the backend resumes `session.log` from. */
	cursor: Schema.optionalKey(Schema.Int),
	/** The app event log seq of the last update published; a view subscribes after it. */
	seq: Schema.Int,
});
export type Snapshot = typeof Snapshot.Type;

/** The answer to a page request: messages up to `before`, oldest first. */
export const Window = Schema.Union([
	Schema.TaggedStruct("Window", {
		info: Info,
		messages: Schema.Array(HistoryEntry),
		/** The snapshot's seq: a view subscribes for updates after it. */
		seq: Schema.Int,
		/** Whether older messages remain. */
		more: Schema.Boolean,
	}),
	Schema.TaggedStruct("Failed", { message: Schema.String }),
]);
export type Window = typeof Window.Type;

/** Published on a session's topic as its conversation changes. */
export const Update = Schema.Union([
	Schema.TaggedStruct("Info", { info: Info }),
	/** A message added or changed, replacing any with the same id. */
	Schema.TaggedStruct("Message", { message: HistoryEntry }),
	/** A message no longer on the session's active branch. */
	Schema.TaggedStruct("Removed", { id: Schema.String }),
	/** Whether the agent is working on the session; sent live only, never stored. */
	Schema.TaggedStruct("Running", { running: Schema.Boolean }),
]);
export type Update = typeof Update.Type;

/** JSON codecs for the bus and kv, which carry plain JSON. */
export const Json = {
	Follow: Schema.toCodecJson(Follow),
	Prompt: Schema.toCodecJson(Prompt),
	Create: Schema.toCodecJson(Create),
	Created: Schema.toCodecJson(Created),
	Interrupt: Schema.toCodecJson(Interrupt),
	Window: Schema.toCodecJson(Window),
	Reply: Schema.toCodecJson(Reply),
	Snapshot: Schema.toCodecJson(Snapshot),
	Update: Schema.toCodecJson(Update),
};
