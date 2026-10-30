import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

/*
 * The CodeWork RPC server's contract, mirrored for what the desktop app and widget backends call.
 * The source of truth is packages/codework/src/server (contract.ts, part.ts, envelope.ts); keep
 * these in step until both import a shared schema package.
 */

export const TextContent = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
export const ImageContent = Schema.Struct({
	type: Schema.Literal("image"),
	data: Schema.String,
	mimeType: Schema.String,
});
export const ThinkingContent = Schema.Struct({
	type: Schema.Literal("thinking"),
	thinking: Schema.String,
	/** The provider withheld the reasoning; `thinking` is then empty. */
	redacted: Schema.optionalKey(Schema.Boolean),
});

export const ToolStatus = Schema.Literals(["pending", "running", "completed", "error", "skipped", "aborted"]);
export type ToolStatus = typeof ToolStatus.Type;

export const ToolResult = Schema.Struct({
	content: Schema.Array(Schema.Union([TextContent, ImageContent])),
	isError: Schema.Boolean,
});

export const ToolCall = Schema.Struct({
	type: Schema.Literal("toolCall"),
	callID: Schema.String,
	name: Schema.String,
	arguments: Schema.Record(Schema.String, Schema.Json),
	status: ToolStatus,
	/** Present once the call settled (completed, error, skipped, aborted). */
	result: Schema.optionalKey(ToolResult),
	/** Epoch milliseconds: started, and last lifecycle update. */
	time: Schema.optionalKey(Schema.Struct({ start: Schema.Finite, end: Schema.Finite })),
});
export type ToolCall = typeof ToolCall.Type;

export const Part = Schema.Union([TextContent, ImageContent, ThinkingContent, ToolCall]);
export type Part = typeof Part.Type;

/** One message in a thread's line, inherited ones first, oldest first. */
export const HistoryEntry = Schema.Struct({
	id: Schema.String,
	seq: Schema.Int,
	role: Schema.Literals(["user", "assistant"]),
	/** `draft` is a reply still streaming; `aborted` one that was interrupted. */
	state: Schema.Literals(["committed", "draft", "aborted"]),
	/** Epoch milliseconds. */
	createdAt: Schema.Finite,
	/** Epoch milliseconds of the last change; for a reply, when it ended once it is no longer a draft. */
	updatedAt: Schema.Finite,
	parts: Schema.Array(Part),
});
export type HistoryEntry = typeof HistoryEntry.Type;

/** How hard a model reasons, ascending. */
export const ThinkingLevel = Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = typeof ThinkingLevel.Type;

export const SessionInfo = Schema.Struct({
	id: Schema.String,
	directory: Schema.String,
	hostDir: Schema.optionalKey(Schema.String),
	/** The sandbox the session runs in; absent for the host itself. */
	sandbox: Schema.optionalKey(Schema.Struct({ driver: Schema.String })),
	project: Schema.optionalKey(Schema.Struct({ id: Schema.String, name: Schema.String })),
	updatedAt: Schema.Finite,
	/** Where unaddressed prompts go. */
	mainThreadId: Schema.String,
});
export type SessionInfo = typeof SessionInfo.Type;

/** One linear transcript of a session, with the session embedded. */
export const ThreadInfo = Schema.Struct({
	id: Schema.String,
	origin: Schema.Struct({ kind: Schema.Literals(["main", "fork", "subagent"]) }),
	/** Absent until its first prompt. */
	title: Schema.optionalKey(Schema.String),
	updatedAt: Schema.Finite,
	model: Schema.optionalKey(Schema.Struct({ provider: Schema.String, id: Schema.String })),
	/** The thinking level chosen for this thread; absent when settings decide. */
	thinkingLevel: Schema.optionalKey(ThinkingLevel),
	session: SessionInfo,
});
export type ThreadInfo = typeof ThreadInfo.Type;

/** What a client calls a thread its first prompt has not named yet. */
export const UNTITLED = "Session";

/** A harness event as the server sends it; `data` stays encoded, decoded per `type` by its reader. */
export const EventEnvelope = Schema.Struct({
	id: Schema.String,
	type: Schema.String,
	durable: Schema.optionalKey(Schema.Struct({ aggregateId: Schema.String, seq: Schema.Int, version: Schema.Int })),
	metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	data: Schema.Unknown,
});
export type EventEnvelope = typeof EventEnvelope.Type;

/** Ends `session.log`'s replay at the head it read; `seq` is absent while the log is empty. */
export const LogSynced = Schema.Struct({
	type: Schema.Literal("log.synced"),
	aggregateId: Schema.String,
	seq: Schema.optionalKey(Schema.Int),
});
export type LogSynced = typeof LogSynced.Type;

/** How a prompt sent while the agent works joins the turn: folded into it, or queued after it. */
export const Delivery = Schema.Literals(["steer", "followUp"]);
export type Delivery = typeof Delivery.Type;

/** A prompt admitted but not yet in the conversation, until the agent takes it in. */
export const QueuedPrompt = Schema.Struct({
	/** The id of the user message it becomes. */
	id: Schema.String,
	delivery: Delivery,
	text: Schema.String,
	/** Epoch milliseconds. */
	createdAt: Schema.Finite,
});
export type QueuedPrompt = typeof QueuedPrompt.Type;

/** The server's "no such session" (the harness `SessionNotFoundError`), by its wire tag. */
export class SessionNotFoundError extends Schema.TaggedError<SessionNotFoundError>()("SessionNotFoundError", {
	sessionId: Schema.String,
}) {}

/** A prompt reused a message id the thread already holds for another prompt. */
export class PromptConflictError extends Schema.TaggedError<PromptConflictError>()("PromptConflictError", {
	threadId: Schema.String,
	messageId: Schema.String,
}) {}

/** A live subscriber fell too far behind; the server dropped it. */
export class SubscriptionOverflowError extends Schema.TaggedError<SubscriptionOverflowError>()(
	"SubscriptionOverflowError",
	{ capacity: Schema.Int },
) {}

/** The server could not encode an event for the wire; it disconnects every live subscriber. */
export class EventEncodingError extends Schema.TaggedError<EventEncodingError>()("EventEncodingError", {
	type: Schema.String,
	cause: Schema.Defect(),
}) {}

/** A provider the server can call, with the models a session may use from it. */
export const ModelProvider = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	models: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			/** In ascending order; `["off"]` for a model that does not reason. */
			thinkingLevels: Schema.Array(ThinkingLevel),
		}),
	),
});
export type ModelProvider = typeof ModelProvider.Type;

/** What `model.list` answers: the usable providers, and the model settings pick when none is chosen. */
export const ModelList = Schema.Struct({
	providers: Schema.Array(ModelProvider),
	default: Schema.Struct({
		provider: Schema.String,
		id: Schema.String,
		thinkingLevel: ThinkingLevel,
		/** Display names from the catalog, present even when its provider is not listed. */
		name: Schema.optionalKey(Schema.String),
		providerName: Schema.optionalKey(Schema.String),
	}),
});
export type ModelList = typeof ModelList.Type;

/** A settings file could not be read or decoded. */
export class SettingsError extends Schema.TaggedError<SettingsError>()("SettingsError", {
	path: Schema.String,
	detail: Schema.String,
}) {}

/** The model catalog is unreadable or invalid. */
export class ModelCatalogError extends Schema.TaggedError<ModelCatalogError>()("Runner.ModelCatalogError", {
	path: Schema.String,
	detail: Schema.String,
}) {}

/** Reuse a sandbox by id, or provision one from a driver, e.g. `{ driver: "memory" }`. */
export const SandboxSelection = Schema.Union([
	Schema.Struct({ id: Schema.String }),
	Schema.Struct({ driver: Schema.String, providerResourceId: Schema.optionalKey(Schema.String) }),
]);
export type SandboxSelection = typeof SandboxSelection.Type;

export const RuntimeConfig = Schema.Struct({
	model: Schema.optionalKey(Schema.Struct({ provider: Schema.String, id: Schema.String })),
	thinkingLevel: Schema.optionalKey(ThinkingLevel),
});
export type RuntimeConfig = typeof RuntimeConfig.Type;

/**
 * Why `session.create` failed, by the server's wire tags. Each keeps only the fields read here;
 * the rest of what the server sends is ignored on decode.
 */
export const CreateError = Schema.Union([
	SessionNotFoundError,
	Schema.TaggedStruct("ThreadNotFoundError", { threadId: Schema.String }),
	Schema.TaggedStruct("SessionLinkedSpaceNotFoundError", { sessionId: Schema.String }),
	Schema.TaggedStruct("RelinkError", { sessionId: Schema.String, reason: Schema.String }),
	Schema.TaggedStruct("SandboxNotFoundError", { id: Schema.String }),
	Schema.TaggedStruct("SandboxDriverNotRegisteredError", { driver: Schema.String }),
	Schema.TaggedStruct("SandboxDriverRegistrationError", { driver: Schema.String, reason: Schema.String }),
	Schema.TaggedStruct("SandboxUnsupportedError", { driver: Schema.String, operation: Schema.String }),
	Schema.TaggedStruct("SandboxProviderError", { driver: Schema.String, operation: Schema.String }),
	Schema.TaggedStruct("SandboxUnavailError", { id: Schema.String, reason: Schema.String }),
	Schema.TaggedStruct("SandboxRemovedError", { id: Schema.String }),
	Schema.TaggedStruct("SandboxTransitionConflictError", { id: Schema.String }),
	Schema.TaggedStruct("SandboxBusyError", { id: Schema.String }),
	Schema.TaggedStruct("Location.DirectoryNotFoundError", { directory: Schema.String }),
	Schema.TaggedStruct("Location.NotDirectoryError", { directory: Schema.String }),
]);
export type CreateError = typeof CreateError.Type;

/** A thread of a session; the session's main thread when `threadId` is absent. */
const ThreadRef = { sessionId: Schema.String, threadId: Schema.optionalKey(Schema.String) };

/** The server's "no such thread" (the harness `ThreadNotFoundError`), by its wire tag. */
export class ThreadNotFoundError extends Schema.TaggedError<ThreadNotFoundError>()("ThreadNotFoundError", {
	threadId: Schema.String,
}) {}

const ThreadError = Schema.Union([SessionNotFoundError, ThreadNotFoundError]);

export const Api = RpcGroup.make(
	Rpc.make("server.info", {
		payload: {},
		success: Schema.Struct({ pid: Schema.Int, version: Schema.String }),
	}),
	/**
	 * `hostDir` anchors the session to a host folder; `directory` is a place inside its space.
	 * Without either, the server places it in its own working directory.
	 */
	Rpc.make("session.create", {
		payload: {
			title: Schema.optionalKey(Schema.String),
			directory: Schema.optionalKey(Schema.String),
			hostDir: Schema.optionalKey(Schema.String),
			sandbox: Schema.optionalKey(SandboxSelection),
			runtime: Schema.optionalKey(RuntimeConfig),
			/** Names the project if this creates it; an existing project keeps its name. Trimmed, non-empty. */
			project: Schema.optionalKey(Schema.Struct({ name: Schema.String })),
		},
		/** The session's main thread. */
		success: ThreadInfo,
		error: CreateError,
	}),
	/** The models a session anchored at `hostDir` can use; without it, only the user's settings apply. */
	Rpc.make("model.list", {
		payload: { hostDir: Schema.optionalKey(Schema.String) },
		success: ModelList,
		error: Schema.Union([SettingsError, ModelCatalogError]),
	}),
	/** Threads newest first, of one session or all. */
	Rpc.make("thread.list", {
		payload: { sessionId: Schema.optionalKey(Schema.String) },
		success: Schema.Array(ThreadInfo),
	}),
	/** Sets the thread's model and thinking level over its settings; they apply from its next request. */
	Rpc.make("thread.configure", {
		payload: { ...ThreadRef, runtime: RuntimeConfig },
		success: ThreadInfo,
		error: ThreadError,
	}),
	Rpc.make("thread.info", {
		payload: ThreadRef,
		success: ThreadInfo,
		error: ThreadError,
	}),
	Rpc.make("thread.history", {
		payload: ThreadRef,
		success: Schema.Struct({ entries: Schema.Array(HistoryEntry) }),
		error: ThreadError,
	}),
	/** Prompts admitted but not yet promoted, in admission order; reread whenever the log moves. */
	Rpc.make("thread.queue", {
		payload: ThreadRef,
		success: Schema.Struct({ entries: Schema.Array(QueuedPrompt) }),
		error: ThreadError,
	}),
	/** Durable events of every thread after `after` (exclusive), then `log.synced`; with `follow`, each new one as it commits. */
	Rpc.make("session.log", {
		payload: {
			sessionId: Schema.String,
			after: Schema.optionalKey(Schema.Int),
			follow: Schema.optionalKey(Schema.Boolean),
		},
		success: Schema.Union([EventEnvelope, LogSynced]),
		error: SessionNotFoundError,
		stream: true,
	}),
	/** `id` names the user message the prompt becomes; it is the prompt's correlation id. */
	Rpc.make("thread.prompt", {
		payload: {
			...ThreadRef,
			text: Schema.String,
			delivery: Schema.optionalKey(Delivery),
			id: Schema.optionalKey(Schema.String),
		},
		success: Schema.Struct({ threadId: Schema.String }),
		error: Schema.Union([ThreadError, PromptConflictError]),
	}),
	/** Withdraws a queued prompt; `cancelled` is false when it was already promoted or is unknown. */
	Rpc.make("thread.cancel", {
		payload: { ...ThreadRef, messageId: Schema.String },
		success: Schema.Struct({ cancelled: Schema.Boolean }),
		error: ThreadError,
	}),
	/** Moves a queued prompt to the other lane or rewrites it in place; `delivery: "steer"` also wakes the thread. */
	Rpc.make("thread.update", {
		payload: {
			...ThreadRef,
			messageId: Schema.String,
			delivery: Schema.optionalKey(Delivery),
			text: Schema.optionalKey(Schema.String),
		},
		success: Schema.Struct({ updated: Schema.Boolean }),
		error: ThreadError,
	}),
	/** Stops every thread of the session. */
	Rpc.make("session.interrupt", {
		payload: { sessionId: Schema.String },
		success: Schema.Struct({ interrupted: Schema.Boolean }),
	}),
	/**
	 * Every event as it happens, durable and live-only alike (text deltas, execution state), after a
	 * `server.connected` frame. Nothing is replayed: what a reader misses while away is gone.
	 */
	Rpc.make("event.subscribe", {
		payload: {},
		success: EventEnvelope,
		error: Schema.Union([SubscriptionOverflowError, EventEncodingError]),
		stream: true,
	}),
);

export * as Codework from "./codework.ts";
