import { Delivery, HistoryEntry, LiveDelta, QueuedPrompt, RunState, ThinkingLevel } from "@codeworksh/widget/codework";
import { Schema } from "effect";

/*
 * What the Session view and backend agree on: the topics they use and the payloads on them. Both
 * halves import this file, so it stays free of React and the DOM.
 */

/** A thread of a session: `threadId`, or the session's main thread when absent. */
export const ThreadRef = Schema.Struct({ sessionId: Schema.String, threadId: Schema.optionalKey(Schema.String) });
export type ThreadRef = typeof ThreadRef.Type;

/**
 * What names a thread in addresses and topics: its session's id for the main thread, else
 * `<session>/<thread>`. The main thread is never named by its own id, so it has one key.
 */
export const threadKey = ({ sessionId, threadId }: ThreadRef) =>
	threadId === undefined ? sessionId : `${sessionId}/${threadId}`;

export const topics = {
	/** Requests: start following a thread; answered once its detail is current, or at once while its machine is away. */
	follow: "codework/session.follow",
	/** Requests: create a session and send its first prompt; answered with its id. */
	create: "codework/session.create",
	prompt: "codework/session.prompt",
	/** Requests: choose a thread's model or thinking level; they apply from its next turn. */
	configure: "codework/session.configure",
	interrupt: "codework/session.interrupt",
	/** Requests: withdraw a queued prompt before the agent takes it in; answered with `Cancelled`. */
	cancel: "codework/session.cancel",
	/** Requests: move a queued prompt to the other lane, or rewrite it, in place. */
	change: "codework/session.change",
	/** Requests: fork a thread at a committed message; answered with the new thread once app.db holds it. */
	fork: "codework/session.fork",
	/** Requests: a window of a followed thread's conversation, newest first back from `before`. */
	page: "codework/session.page",
	/** Updates to one thread's conversation, by its {@link threadKey}. */
	thread: (key: string) => `codework/session/${key}`,
};

export const Follow = ThreadRef;

export const Prompt = Schema.Struct({
	...ThreadRef.fields,
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

export const Interrupt = ThreadRef;

export const Cancel = Schema.Struct({ ...ThreadRef.fields, messageId: Schema.String });

/** The answer to a cancel: withdrawn, already in the conversation, or why neither is known. */
export const Cancelled = Schema.Union([
	Schema.TaggedStruct("Cancelled", {}),
	Schema.TaggedStruct("Sent", {}),
	Schema.TaggedStruct("Failed", { message: Schema.String }),
]);
export type Cancelled = typeof Cancelled.Type;

/** A queued prompt moved to `delivery`, or given new `text`; an absent key is left as it is. */
export const Change = Schema.Struct({
	...ThreadRef.fields,
	messageId: Schema.String,
	delivery: Schema.optionalKey(Delivery),
	text: Schema.optionalKey(Schema.String),
});

/** A model or thinking level chosen for a thread; an absent key is left as it is. */
export const Configure = Schema.Struct({
	...ThreadRef.fields,
	model: Schema.optionalKey(Schema.Struct({ provider: Schema.String, id: Schema.String })),
	thinkingLevel: Schema.optionalKey(ThinkingLevel),
});
export type Configure = typeof Configure.Type;

export const Fork = Schema.Struct({ ...ThreadRef.fields, entryId: Schema.String });

/** The answer to a fork: the new thread of the same session, or why there is none. */
export const Forked = Schema.Union([
	Schema.TaggedStruct("Forked", { threadId: Schema.String }),
	Schema.TaggedStruct("Failed", { message: Schema.String }),
]);
export type Forked = typeof Forked.Type;

export const Page = Schema.Struct({
	...ThreadRef.fields,
	/** The seq of the oldest message the view holds; omitted asks for the newest messages. */
	before: Schema.optionalKey(Schema.Int),
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
	machineId: Schema.String,
	/** The space the session is placed in. */
	spaceId: Schema.String,
	/** The host folder the session is anchored to, whose project settings it reads. */
	hostDir: Schema.optionalKey(Schema.String),
	project: Schema.optionalKey(Schema.Struct({ id: Schema.String, name: Schema.String })),
	model: Schema.optionalKey(Schema.Struct({ provider: Schema.String, id: Schema.String })),
	/** The thinking level chosen for the session; absent when settings decide. */
	thinkingLevel: Schema.optionalKey(ThinkingLevel),
	/** Last activity, epoch milliseconds. */
	updated: Schema.Number,
	/** Where the thread's run is, as the harness stores it. */
	runState: RunState,
	/** The run is still going, but CodeWork has accepted a stop for it. */
	stopping: Schema.Boolean,
	/** Its queued prompts wait for the next message instead of running by themselves. */
	parked: Schema.Boolean,
	/**
	 * Why the last run failed: CodeWork's failure category (`sandbox-mount-error` and the like) and
	 * its message. Absent once another run starts, or when it did not fail.
	 */
	failure: Schema.optionalKey(Schema.Struct({ kind: Schema.String, message: Schema.String })),
});
export type Info = typeof Info.Type;

/** The answer to a page request: messages up to `before`, oldest first. */
export const Window = Schema.Union([
	Schema.TaggedStruct("Window", {
		info: Info,
		messages: Schema.Array(HistoryEntry),
		queued: Schema.Array(QueuedPrompt),
		/** The bus head before the read: a view subscribes for updates after it. */
		seq: Schema.Int,
		/** Whether older messages remain. */
		more: Schema.Boolean,
	}),
	Schema.TaggedStruct("Failed", { message: Schema.String }),
]);
export type Window = typeof Window.Type;

/** Published on a thread's topic as its conversation changes. */
export const Update = Schema.Union([
	Schema.TaggedStruct("Info", { info: Info }),
	/** A message added or changed, replacing any with the same id. */
	Schema.TaggedStruct("Message", { message: HistoryEntry }),
	/** The prompts still waiting to join the conversation, replacing the last list. */
	Schema.TaggedStruct("Queue", { queued: Schema.Array(QueuedPrompt) }),
	/** Text streamed into a draft since its last checkpoint; sent live only, never stored. */
	Schema.TaggedStruct("Delta", { delta: LiveDelta }),
]);
export type Update = typeof Update.Type;

/** JSON codecs for the bus, which carries plain JSON. */
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
	Fork: Schema.toCodecJson(Fork),
	Forked: Schema.toCodecJson(Forked),
	Window: Schema.toCodecJson(Window),
	Reply: Schema.toCodecJson(Reply),
	Update: Schema.toCodecJson(Update),
};
