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

/** The models could not be listed: a settings file or the model catalog, at `path`, is broken. */
export class ModelsError extends Schema.TaggedError<ModelsError>()("Server.ModelsError", {
	source: Schema.Literals(["settings", "catalog"]),
	path: Schema.String,
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

/**
 * The `codework` executable the app uses, and its `--version`, or why that failed. `custom` when it
 * is the path chosen in Settings rather than the one found.
 */
export const CliInstall = Schema.Union([
	Schema.Struct({ path: Schema.String, custom: Schema.Boolean, version: Schema.String }),
	Schema.Struct({ path: Schema.String, custom: Schema.Boolean, failure: Schema.String }),
]);
export type CliInstall = typeof CliInstall.Type;

/**
 * The CodeWork server registered in the home. `Incompatible` answers but its replies do not decode
 * here: another build, even one with the same version.
 */
export const CliServer = Schema.Union([
	Schema.TaggedStruct("Running", { url: Schema.String, pid: Schema.Int, version: Schema.String }),
	Schema.TaggedStruct("Incompatible", { url: Schema.String, pid: Schema.Int, version: Schema.String }),
	Schema.TaggedStruct("Stopped", {}),
	Schema.TaggedStruct("Unreachable", { url: Schema.String, pid: Schema.Int }),
]);
export type CliServer = typeof CliServer.Type;

/**
 * A variable the server is started with. A sensitive one's value never leaves the app server, so
 * it comes without `value`; sent back without one, the saved value stays.
 */
export const CliEnvVar = Schema.Struct({
	name: Schema.String,
	sensitive: Schema.Boolean,
	value: Schema.optionalKey(Schema.String),
});
export type CliEnvVar = typeof CliEnvVar.Type;

/** Only servers on this machine for now; remote ones come later. */
export const ServerKind = Schema.Literals(["local"]);

/** The server the app always has, which cannot be removed. */
export const LOCAL_SERVER = "local";

/** A server and how it is set up, with its executable and process as found when listed. */
export const ServerStatus = Schema.Struct({
	id: Schema.String,
	kind: ServerKind,
	name: Schema.String,
	/** The one the app connects to. */
	isDefault: Schema.Boolean,
	/**
	 * The CodeWork home whose `service.json` names the server; `custom` when chosen in Settings, and
	 * `fallback` the one used otherwise (only the built-in server has one).
	 */
	home: Schema.Struct({ path: Schema.String, custom: Schema.Boolean, fallback: Schema.NullOr(Schema.String) }),
	/** None when no `codework` was found. */
	cli: Schema.NullOr(CliInstall),
	server: CliServer,
	/** Extra arguments for `codework service start` and `restart`, as typed. */
	args: Schema.String,
	env: Schema.Array(CliEnvVar),
});
export type ServerStatus = typeof ServerStatus.Type;

export const CliAction = Schema.Literals(["start", "restart", "stop"]);
export type CliAction = typeof CliAction.Type;

/** A new local server: it needs a home of its own, since a home names one server. */
export const ServerAdd = Schema.Struct({
	name: Schema.String,
	executable: Schema.NullOr(Schema.String),
	home: Schema.String,
	args: Schema.String,
});
export type ServerAdd = typeof ServerAdd.Type;

/**
 * Changes to a server; an absent field is left as it is. A `null` path goes back to the one found;
 * `env` replaces every variable.
 */
export const ServerUpdate = Schema.Struct({
	id: Schema.String,
	name: Schema.optionalKey(Schema.String),
	executable: Schema.optionalKey(Schema.NullOr(Schema.String)),
	home: Schema.optionalKey(Schema.NullOr(Schema.String)),
	args: Schema.optionalKey(Schema.String),
	env: Schema.optionalKey(Schema.Array(CliEnvVar)),
});
export type ServerUpdate = typeof ServerUpdate.Type;

export const ServerId = Schema.Struct({ id: Schema.String });

export class ServersError extends Schema.TaggedError<ServersError>()("Server.ServersError", {
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
	/** Every server, the built-in one first, then in the order added. */
	Rpc.make("servers.list", {
		success: Schema.Array(ServerStatus),
	}),
	Rpc.make("servers.add", {
		payload: ServerAdd,
		success: Schema.String,
		error: ServersError,
	}),
	/** A new home for the default server reconnects the app at once. */
	Rpc.make("servers.update", {
		payload: ServerUpdate,
		success: Schema.Void,
		error: ServersError,
	}),
	/** The default server and the built-in one stay. */
	Rpc.make("servers.remove", {
		payload: ServerId,
		success: Schema.Void,
		error: ServersError,
	}),
	/** The app reconnects through the new default's home at once. */
	Rpc.make("servers.setDefault", {
		payload: ServerId,
		success: Schema.Void,
		error: ServersError,
	}),
	/** Runs `codework service <action>` with the server's executable, home, arguments and variables. */
	Rpc.make("servers.service", {
		payload: { id: Schema.String, action: CliAction },
		success: Schema.Void,
		error: ServersError,
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
