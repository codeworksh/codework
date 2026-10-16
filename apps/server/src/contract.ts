import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { Event, EventTimeout, Publish, Request, Synced } from "@codeworksh/widget/event";

/** A conversation with the agent, as listed under its project. */
export const SessionSummary = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	/** Last activity, epoch milliseconds. */
	updated: Schema.Number,
	/** The model chosen for the session; absent when settings decide. */
	model: Schema.optionalKey(Schema.Struct({ provider: Schema.String, id: Schema.String })),
});
export type SessionSummary = typeof SessionSummary.Type;

export const Project = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	path: Schema.String,
	sessions: Schema.Array(SessionSummary),
});
export type Project = typeof Project.Type;

/** The CodeWork server that owns projects and sessions is not running, or did not answer. */
export class CodeworkUnavailable extends Schema.TaggedError<CodeworkUnavailable>()("Server.CodeworkUnavailable", {
	message: Schema.String,
}) {}

/*
 * A conversation as the CodeWork server sends it, mirrored from packages/codework/src/server
 * (part.ts and the `session.history` entry in contract.ts). Keep the two in step until both import
 * a shared schema package.
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

/** One session with its conversation. */
export const Session = Schema.Struct({
	...SessionSummary.fields,
	project: Schema.optionalKey(Schema.Struct({ id: Schema.String, name: Schema.String })),
	entries: Schema.Array(HistoryEntry),
});
export type Session = typeof Session.Type;

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()("Server.SessionNotFound", {
	id: Schema.String,
}) {}

export const Layout = Schema.Literals(["tile", "monocle"]);
export type Layout = typeof Layout.Type;

/**
 * A workspace. `bit` is its webwm tag bit, fixed for life so reordering never
 * rewrites widget masks; `pos` is its place in the switcher and its Cmd+N key.
 */
export const Workspace = Schema.Struct({
	id: Schema.String,
	bit: Schema.Number,
	pos: Schema.Number,
	name: Schema.String,
	/** A name from the app's icon set, e.g. "code". */
	icon: Schema.String,
	layout: Layout,
	/** Master column share of the width, 0–1. */
	mfact: Schema.Number,
	/** Created to show something the user opened (a session); removed once it shows nothing. */
	auto: Schema.Boolean,
});
export type Workspace = typeof Workspace.Type;

export const WorkspaceCreate = Schema.Struct({
	name: Schema.String,
	icon: Schema.String,
	auto: Schema.optionalKey(Schema.Boolean),
});
export const WorkspaceUpdate = Schema.Struct({
	id: Schema.String,
	name: Schema.optional(Schema.String),
	icon: Schema.optional(Schema.String),
	layout: Schema.optional(Layout),
	mfact: Schema.optional(Schema.Number),
});
export const WorkspaceOrder = Schema.Struct({ ids: Schema.Array(Schema.String) });
export const WorkspaceId = Schema.Struct({ id: Schema.String });

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("Server.WorkspaceError", {
	message: Schema.String,
}) {}

/** Package-scoped JSON storage: `package` namespaces keys so packages never collide. */
const KvKey = { package: Schema.String, key: Schema.String };

export const Api = RpcGroup.make(
	Rpc.make("projects.list", {
		success: Schema.Array(Project),
		error: CodeworkUnavailable,
	}),
	Rpc.make("sessions.get", {
		payload: { id: Schema.String },
		success: Session,
		error: Schema.Union([SessionNotFound, CodeworkUnavailable]),
	}),
	Rpc.make("workspaces.list", {
		success: Schema.Array(Workspace),
	}),
	Rpc.make("workspaces.create", {
		payload: WorkspaceCreate,
		success: Workspace,
		error: WorkspaceError,
	}),
	Rpc.make("workspaces.update", {
		payload: WorkspaceUpdate,
		success: Schema.Void,
		error: WorkspaceError,
	}),
	/** Puts the workspaces in this order; `ids` must name every workspace once. */
	Rpc.make("workspaces.reorder", {
		payload: WorkspaceOrder,
		success: Schema.Void,
		error: WorkspaceError,
	}),
	Rpc.make("workspaces.delete", {
		payload: WorkspaceId,
		success: Schema.Void,
		error: WorkspaceError,
	}),
	Rpc.make("kv.get", {
		payload: KvKey,
		success: Schema.OptionFromNullOr(Schema.Json),
	}),
	Rpc.make("kv.set", {
		payload: { ...KvKey, value: Schema.Json },
		success: Schema.Void,
	}),
	Rpc.make("event.publish", {
		payload: Publish,
		success: Event,
	}),
	/**
	 * Publishes a request and returns its reply: the first event on the same topic whose `cause` is
	 * the request's id. A request republished with its id returns the reply already stored.
	 */
	Rpc.make("event.request", {
		payload: Request,
		success: Event,
		error: EventTimeout,
	}),
	/**
	 * Events on `topics`: those after `after` from the log, then `Synced`, then live ones. Without
	 * `after` nothing is replayed, so `Synced` comes first and carries the current head.
	 */
	Rpc.make("event.subscribe", {
		payload: { topics: Schema.Array(Schema.String), after: Schema.optional(Schema.Int) },
		success: Schema.Union([Event, Synced]),
		stream: true,
	}),
);

export * as Contract from "./contract.ts";
