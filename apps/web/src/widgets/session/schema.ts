import { Delivery, HistoryEntry, QueuedPrompt, ThinkingLevel } from "@codeworksh/widget/codework";
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
	/** Requests: choose a session's model or thinking level; they apply from its next exchange. */
	configure: "codework/session.configure",
	interrupt: "codework/session.interrupt",
	/** Requests: withdraw a queued prompt before the agent takes it in; answered with `Cancelled`. */
	cancel: "codework/session.cancel",
	/** Requests: move a queued prompt to the other lane, or rewrite it, in place. */
	change: "codework/session.change",
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

export const Cancel = Schema.Struct({ sessionId: Schema.String, messageId: Schema.String });

/** The answer to a cancel: withdrawn, already in the conversation, or why neither is known. */
export const Cancelled = Schema.Union([
	Schema.TaggedStruct("Cancelled", {}),
	Schema.TaggedStruct("Sent", {}),
	Schema.TaggedStruct("Failed", { message: Schema.String }),
]);
export type Cancelled = typeof Cancelled.Type;

/** A queued prompt moved to `delivery`, or given new `text`; an absent key is left as it is. */
export const Change = Schema.Struct({
	sessionId: Schema.String,
	messageId: Schema.String,
	delivery: Schema.optionalKey(Delivery),
	text: Schema.optionalKey(Schema.String),
});

/** A model or thinking level chosen for a session; an absent key is left as it is. */
export const Configure = Schema.Struct({
	sessionId: Schema.String,
	model: Schema.optionalKey(Schema.Struct({ provider: Schema.String, id: Schema.String })),
	thinkingLevel: Schema.optionalKey(ThinkingLevel),
});
export type Configure = typeof Configure.Type;

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
	/** The host folder the session is anchored to, whose project settings it reads. */
	hostDir: Schema.optionalKey(Schema.String),
	/** The sandbox driver the session runs in, `memory` say; absent for the host itself. */
	sandbox: Schema.optionalKey(Schema.String),
	project: Schema.optionalKey(Schema.Struct({ id: Schema.String, name: Schema.String })),
	model: Schema.optionalKey(Schema.Struct({ provider: Schema.String, id: Schema.String })),
	/** The thinking level chosen for the session; absent when settings decide. */
	thinkingLevel: Schema.optionalKey(ThinkingLevel),
	/** Last activity, epoch milliseconds. */
	updated: Schema.Number,
});
export type Info = typeof Info.Type;

/** A session as the backend keeps it in kv and a view loads before subscribing. */
export const Snapshot = Schema.Struct({
	info: Info,
	messages: Schema.Array(HistoryEntry),
	/** Prompts sent but not yet in the conversation, oldest first. */
	queued: Schema.Array(QueuedPrompt),
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
		queued: Schema.Array(QueuedPrompt),
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
	/** The prompts still waiting to join the conversation, replacing the last list. */
	Schema.TaggedStruct("Queue", { queued: Schema.Array(QueuedPrompt) }),
	/** A message no longer on the session's active branch. */
	Schema.TaggedStruct("Removed", { id: Schema.String }),
	/** Whether the agent is working on the session; sent live only, never stored. */
	Schema.TaggedStruct("Running", { running: Schema.Boolean }),
	/**
	 * Why the agent's work on the session failed: CodeWork's failure category (`sandbox-mount-error`
	 * and the like) and its message. Sent live only, never stored.
	 */
	Schema.TaggedStruct("Failed", { kind: Schema.String, message: Schema.String }),
]);
export type Update = typeof Update.Type;

/** JSON codecs for the bus and kv, which carry plain JSON. */
export const Json = {
	Follow: Schema.toCodecJson(Follow),
	Prompt: Schema.toCodecJson(Prompt),
	Create: Schema.toCodecJson(Create),
	Created: Schema.toCodecJson(Created),
	Interrupt: Schema.toCodecJson(Interrupt),
	Cancel: Schema.toCodecJson(Cancel),
	Cancelled: Schema.toCodecJson(Cancelled),
	Change: Schema.toCodecJson(Change),
	Configure: Schema.toCodecJson(Configure),
	Window: Schema.toCodecJson(Window),
	Reply: Schema.toCodecJson(Reply),
	Snapshot: Schema.toCodecJson(Snapshot),
	Update: Schema.toCodecJson(Update),
};
