import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { ModelList } from "@codeworksh/widget/codework";
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

/** The models could not be listed: a settings file or the model catalog is broken. */
export class ModelsError extends Schema.TaggedError<ModelsError>()("Server.ModelsError", {
	message: Schema.String,
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

/**
 * One placed widget on the desk. `tags` is its webwm mask: the workspaces it shows on, by their
 * bits. `props` and `params` are the widget's own JSON; the server keeps them as given.
 */
export const Instance = Schema.Struct({
	id: Schema.String,
	kind: Schema.String,
	tags: Schema.Number,
	props: Schema.Json,
	pinned: Schema.Boolean,
	title: Schema.optionalKey(Schema.String),
	address: Schema.optionalKey(Schema.String),
	params: Schema.optionalKey(Schema.Json),
	openedBy: Schema.optionalKey(Schema.String),
});
export type Instance = typeof Instance.Type;

/** Every widget on every workspace, with the desk-wide tile and focus order over their ids. */
export const Desk = Schema.Struct({
	instances: Schema.Array(Instance),
	tileOrder: Schema.Array(Schema.String),
	focusOrder: Schema.Array(Schema.String),
});
export type Desk = typeof Desk.Type;

export class DeskError extends Schema.TaggedError<DeskError>()("Server.DeskError", {
	message: Schema.String,
}) {}

/** Package-scoped JSON storage: `package` namespaces keys so packages never collide. */
const KvKey = { package: Schema.String, key: Schema.String };

export const Api = RpcGroup.make(
	Rpc.make("projects.list", {
		success: Schema.Array(Project),
		error: CodeworkUnavailable,
	}),
	/** The models a new session can use; `hostDir` is its folder, whose project settings apply. */
	Rpc.make("models.list", {
		payload: { hostDir: Schema.optionalKey(Schema.String) },
		success: ModelList,
		error: Schema.Union([CodeworkUnavailable, ModelsError]),
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
	Rpc.make("desk.get", {
		success: Desk,
	}),
	/** Replaces the whole desk; both orders must name every instance exactly once. */
	Rpc.make("desk.save", {
		payload: Desk,
		success: Schema.Void,
		error: DeskError,
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
