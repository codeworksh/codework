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

/** One message on a session's active branch, oldest first. */
export const HistoryEntry = Schema.Struct({
	id: Schema.String,
	seq: Schema.Int,
	role: Schema.Literals(["user", "assistant"]),
	/** `draft` is a reply still streaming; `aborted` one that was interrupted. */
	state: Schema.Literals(["committed", "draft", "aborted"]),
	/** Epoch milliseconds. */
	createdAt: Schema.Finite,
	parts: Schema.Array(Part),
});
export type HistoryEntry = typeof HistoryEntry.Type;

export const SessionInfo = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	directory: Schema.String,
	hostDir: Schema.optionalKey(Schema.String),
	project: Schema.optionalKey(Schema.Struct({ id: Schema.String, name: Schema.String })),
	updatedAt: Schema.Finite,
	model: Schema.optionalKey(Schema.Struct({ provider: Schema.String, id: Schema.String })),
});
export type SessionInfo = typeof SessionInfo.Type;

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

/** The server's "no such session" (the harness `SessionNotFoundError`), by its wire tag. */
export class SessionNotFoundError extends Schema.TaggedError<SessionNotFoundError>()("SessionNotFoundError", {
	sessionId: Schema.String,
}) {}

/** A prompt reused a message id the session already holds for another prompt. */
export class PromptConflictError extends Schema.TaggedError<PromptConflictError>()("PromptConflictError", {
	sessionId: Schema.String,
	messageId: Schema.String,
}) {}

export const Api = RpcGroup.make(
	Rpc.make("server.info", {
		payload: {},
		success: Schema.Struct({ pid: Schema.Int, version: Schema.String }),
	}),
	Rpc.make("session.list", {
		payload: {},
		success: Schema.Array(SessionInfo),
	}),
	Rpc.make("session.info", {
		payload: { sessionId: Schema.String },
		success: SessionInfo,
		error: SessionNotFoundError,
	}),
	Rpc.make("session.history", {
		payload: { sessionId: Schema.String },
		success: Schema.Struct({ entries: Schema.Array(HistoryEntry) }),
		error: SessionNotFoundError,
	}),
	/** Durable events after `after` (exclusive), then `log.synced`; with `follow`, each new one as it commits. */
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
	Rpc.make("session.prompt", {
		payload: {
			sessionId: Schema.String,
			text: Schema.String,
			delivery: Schema.optionalKey(Delivery),
			id: Schema.optionalKey(Schema.String),
		},
		success: Schema.Void,
		error: Schema.Union([SessionNotFoundError, PromptConflictError]),
	}),
	Rpc.make("session.interrupt", {
		payload: { sessionId: Schema.String },
		success: Schema.Struct({ interrupted: Schema.Boolean }),
	}),
);

export * as Codework from "./codework.ts";
