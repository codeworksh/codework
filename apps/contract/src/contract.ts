import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import {
	CodeworkUnavailable,
	LineRequest,
	LineThread,
	SyncError,
	SyncThread,
	ThreadLine,
} from "@codeworksh/widget/backend";
import {
	Clone,
	ClonePhase,
	CloneStage,
	Folder,
	ModelList,
	Repository,
	RunState,
	SpaceInfo,
} from "@codeworksh/widget/codework";
import { Event, EventTimeout, Publish, Request, Synced } from "@codeworksh/widget/event";

export { CodeworkUnavailable, LineRequest, LineThread, SyncError, SyncThread, ThreadLine };

/** The organization the UI shows until auth exists; every synced project starts in it. */
export const PERSONAL_ORGANIZATION = "personal";

/**
 * Where a thread's work is, as Linear's workflow states. `enqueued` and `working` follow its runs: a
 * run starting sets `working`, which stays when it ends; prompts parked before a run set `enqueued`.
 * The user sets the rest.
 */
export const ThreadStatus = Schema.Literals(["enqueued", "working", "review", "settled", "cancelled"]);
export type ThreadStatus = typeof ThreadStatus.Type;

/** The statuses a user sets; the others follow the thread's runs. */
export const ManualStatus = Schema.Literals(["review", "settled", "cancelled"]);
export type ManualStatus = typeof ManualStatus.Type;

/** Linear's scale: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
export const Priority = Schema.Literals([0, 1, 2, 3, 4]);
export type Priority = typeof Priority.Type;

/** A session as the sidebar lists it: its space's kind, its color and its main thread. */
export const SidebarSession = Schema.Struct({
	id: Schema.String,
	/** Its main thread. */
	threadId: Schema.String,
	spaceKind: SpaceInfo.fields.kind,
	/** Its main thread's color, else its own, as All Threads shows it; hex, null is the default. */
	color: Schema.NullOr(Schema.String),
	/** The main thread's title, or what an untitled one is called. */
	title: Schema.String,
	model: Schema.optionalKey(Schema.Struct({ provider: Schema.String, id: Schema.String })),
	runState: RunState,
	status: ThreadStatus,
	priority: Priority,
	/** When it started: its main thread's creation; epoch milliseconds. */
	created: Schema.Finite,
	/** The session's last activity: the newest change to any of its threads, forks included; epoch milliseconds. */
	updated: Schema.Finite,
	/** The host folder it is anchored to, else its directory. */
	path: Schema.String,
});
export type SidebarSession = typeof SidebarSession.Type;

/** An active project with its sessions, newest first, and the machine it is on. */
export const SidebarProject = Schema.Struct({
	machine: Schema.Struct({ id: Schema.String, name: Schema.String }),
	id: Schema.String,
	name: Schema.String,
	/** Its newest primary-space session's folder, else its primary space's location: where a new thread starts. */
	path: Schema.String,
	/** When it was first seen; epoch milliseconds. */
	created: Schema.Finite,
	sessions: Schema.Array(SidebarSession),
});
export type SidebarProject = typeof SidebarProject.Type;

/** One of a project's directories: its main checkout, a worktree, a copy or a plain folder. */
export const ProjectSpace = Schema.Struct({
	id: Schema.String,
	location: Schema.String,
	kind: SpaceInfo.fields.kind,
	/** The sandbox it is in; null for the host. */
	env: Schema.NullOr(Schema.String),
	status: SpaceInfo.fields.status,
});
export type ProjectSpace = typeof ProjectSpace.Type;

/** One skill as a space's sessions see it: its frontmatter `name` and `description`. */
export const SpaceSkill = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	/** Its frontmatter keeps it out of the prompt. */
	hidden: Schema.Boolean,
});
export type SpaceSkill = typeof SpaceSkill.Type;

/**
 * A space's skills. A host space is read each time; a sandbox only while it runs, else its last read
 * is kept. `skills` is null when it was never read; `syncedAt` is when it was, in epoch milliseconds.
 */
export const SpaceSkills = Schema.Struct({
	space: ProjectSpace,
	/** The sandbox it is in, as last observed; null for the host. */
	sandbox: Schema.NullOr(
		Schema.Struct({
			driver: Schema.String,
			providerResourceId: Schema.NullOr(Schema.String),
			status: Schema.String,
		}),
	),
	skills: Schema.NullOr(Schema.Array(SpaceSkill)),
	syncedAt: Schema.NullOr(Schema.Finite),
});
export type SpaceSkills = typeof SpaceSkills.Type;

/** A host folder operation that failed: unreadable, not a directory, taken, or git/gh refused. */
export class HostError extends Schema.TaggedError<HostError>()("Server.HostError", {
	message: Schema.String,
}) {}

/** A project operation that failed, such as renaming one the server no longer has. */
export class ProjectError extends Schema.TaggedError<ProjectError>()("Server.ProjectError", {
	message: Schema.String,
}) {}

export { Clone, ClonePhase, CloneStage, Folder, Repository };

/** The models could not be listed: a settings file or the model catalog, at `path`, is broken. */
export class ModelsError extends Schema.TaggedError<ModelsError>()("Server.ModelsError", {
	source: Schema.Literals(["settings", "catalog"]),
	path: Schema.String,
	message: Schema.String,
}) {}

/** A settings file the runtime would reject, at `path`; nothing was written. */
export class SettingsError extends Schema.TaggedError<SettingsError>()("Server.SettingsError", {
	path: Schema.String,
	message: Schema.String,
}) {}

/** A settings file changed since it was read; nothing was written. */
export class SettingsConflict extends Schema.TaggedError<SettingsConflict>()("Server.SettingsConflict", {
	path: Schema.String,
}) {}

/** `settings.jsonc` or `mcp.json`: the project's with `projectId`, else the user's. */
export const SettingsFileRef = {
	projectId: Schema.optionalKey(Schema.String),
	file: Schema.Literals(["settings", "mcp"]),
};

/** A settings file as written. `version` is what a write is held to; `error` is what the runtime would reject. */
export const SettingsFile = Schema.Struct({
	path: Schema.String,
	source: Schema.String,
	exists: Schema.Boolean,
	version: Schema.String,
	/** The file's JSONC as a value; absent when it does not parse. */
	value: Schema.optionalKey(Schema.Unknown),
	error: Schema.optionalKey(Schema.String),
	/** For `settings.jsonc`: what applies where this file sets nothing. */
	inherited: Schema.optionalKey(
		Schema.Struct({
			retry: Schema.Struct({ maxRetries: Schema.Int, baseDelayMs: Schema.Int, maxDelayMs: Schema.Int }),
		}),
	),
	/** For `mcp.json`: the servers as sessions use them, user and project merged. */
	servers: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({ name: Schema.String, from: Schema.Literals(["user", "project"]), enabled: Schema.Boolean }),
		),
	),
});
export type SettingsFile = typeof SettingsFile.Type;

/** Every settings call's: only a write can conflict, but one set keeps the app server's mapping single. */
const SettingsErrors = [CodeworkUnavailable, HostError, ProjectError, SettingsError, SettingsConflict] as const;

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
	layout: Layout,
	/** Master column share of the width, 0–1. */
	mfact: Schema.Number,
	/** Created to show something the user opened (a session); removed once it shows nothing. */
	auto: Schema.Boolean,
	/** What its tab last read, as its focused widget set it; absent until a widget has. */
	tab: Schema.optionalKey(Schema.String),
});
export type Workspace = typeof Workspace.Type;

export const WorkspaceCreate = Schema.Struct({
	name: Schema.String,
	auto: Schema.optionalKey(Schema.Boolean),
});
export const WorkspaceUpdate = Schema.Struct({
	id: Schema.String,
	name: Schema.optional(Schema.String),
	layout: Schema.optional(Layout),
	mfact: Schema.optional(Schema.Number),
	tab: Schema.optional(Schema.String),
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

/** A server on this computer (local), or one hosted elsewhere that the app reaches at its URL (remote). */
export const ServerKind = Schema.Literals(["local", "remote"]);

/** The server the app always has, which cannot be removed. */
export const LOCAL_SERVER = "local";

/** A local server and how it is set up, with its executable and process as found when listed. */
export const LocalServerStatus = Schema.Struct({
	id: Schema.String,
	kind: Schema.Literal("local"),
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
export type LocalServerStatus = typeof LocalServerStatus.Type;

/** A remote server: only where to reach it; it has no executable or home here. */
export const RemoteServerStatus = Schema.Struct({
	id: Schema.String,
	kind: Schema.Literal("remote"),
	name: Schema.String,
	isDefault: Schema.Boolean,
	url: Schema.String,
});
export type RemoteServerStatus = typeof RemoteServerStatus.Type;

export const ServerStatus = Schema.Union([LocalServerStatus, RemoteServerStatus]);
export type ServerStatus = typeof ServerStatus.Type;

/** How often every server is checked again in the background. */
export const ServerHealth = Schema.Struct({
	/** Seconds between checks; 0 turns them off. */
	interval: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ServerHealth = typeof ServerHealth.Type;

export const DEFAULT_SERVER_HEALTH: ServerHealth = { interval: 300 };

export const CliAction = Schema.Literals(["start", "restart", "stop"]);
export type CliAction = typeof CliAction.Type;

/**
 * A new server. A local one needs a home of its own, since a home names one server; a remote one
 * needs its WebSocket URL.
 */
export const ServerAdd = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("local"),
		name: Schema.String,
		executable: Schema.NullOr(Schema.String),
		home: Schema.String,
		args: Schema.String,
	}),
	Schema.Struct({ kind: Schema.Literal("remote"), name: Schema.String, url: Schema.String }),
]);
export type ServerAdd = typeof ServerAdd.Type;

/**
 * Changes to a server; an absent field is left as it is. A `null` path goes back to the one found;
 * `env` replaces every variable. `url` is for a remote server only, the rest but `name` for a local one.
 */
export const ServerUpdate = Schema.Struct({
	id: Schema.String,
	name: Schema.optionalKey(Schema.String),
	executable: Schema.optionalKey(Schema.NullOr(Schema.String)),
	home: Schema.optionalKey(Schema.NullOr(Schema.String)),
	args: Schema.optionalKey(Schema.String),
	env: Schema.optionalKey(Schema.Array(CliEnvVar)),
	url: Schema.optionalKey(Schema.String),
});
export type ServerUpdate = typeof ServerUpdate.Type;

export const ServerId = Schema.Struct({ id: Schema.String });

export class ServersError extends Schema.TaggedError<ServersError>()("Server.ServersError", {
	message: Schema.String,
}) {}

/** The app bus topics the sync publishes on. */
export const syncTopics = {
	/** `SyncChanged` after each applied batch; stored. */
	changed: "sync/changed",
	/** `SyncStatus` whenever a thread's status moves; stored, in the transaction that moved it. */
	status: "sync/status",
	/** A thread's live text and thinking deltas (`LiveDelta`) that continue its draft; never stored. */
	delta: (threadId: string) => `sync/delta/${threadId}`,
	/** `SyncTracking` whenever the user edits a desktop column other than status; stored, in the transaction that wrote it. */
	tracking: "sync/tracking",
	/** `SyncState` whenever a space daemon's mirrored state changed (git status, skills); stored. */
	state: "sync/state",
};

/**
 * The rows one applied batch wrote, by table, for one machine. Projects and spaces are keyed by
 * `machineId` and id, the rest by id. `threadId` names the thread whose detail the batch was;
 * `items` counts the rows it carried; `full` marks the first batch of a full sync.
 */
export const SyncChanged = Schema.Struct({
	machineId: Schema.String,
	threadId: Schema.optionalKey(Schema.String),
	full: Schema.Boolean,
	items: Schema.Int,
	project: Schema.Array(Schema.String),
	space: Schema.Array(Schema.String),
	session: Schema.Array(Schema.String),
	thread: Schema.Array(Schema.String),
	entry: Schema.Array(Schema.String),
	inbox: Schema.Array(Schema.String),
	/** Sessions soft-deleted, with their threads. */
	removed: Schema.Array(Schema.String),
});
export type SyncChanged = typeof SyncChanged.Type;

/** A space daemon's last event of `type` for a space was mirrored anew. */
export const SyncState = Schema.Struct({
	machineId: Schema.String,
	spaceId: Schema.String,
	type: Schema.String,
});
export type SyncState = typeof SyncState.Type;

/** A thread's status moved; `at` is the app server's clock. */
export const SyncStatus = Schema.Struct({
	threadId: Schema.String,
	status: ThreadStatus,
	previous: ThreadStatus,
	at: Schema.Number,
});
export type SyncStatus = typeof SyncStatus.Type;

/** A custom group of an organization's threads, in its own `ordering`. */
export const Grouping = Schema.Struct({
	id: Schema.String,
	organizationId: Schema.String,
	name: Schema.String,
	/** Hex, `#rrggbb`. */
	color: Schema.NullOr(Schema.String),
	ordering: Schema.Number,
});
export type Grouping = typeof Grouping.Type;

/** Where a moved thread or group goes in its organization's list: first, last, or between two neighbours. */
export const Position = Schema.Union([
	Schema.Literals(["first", "last"]),
	Schema.Struct({ after: Schema.String, before: Schema.String }),
]);
export type Position = typeof Position.Type;

/**
 * A user edit of a desktop column: a thread's (only the field that changed; a `null` group is
 * ungrouped, a `null` color falls back to the session's), a session's color, a group created or
 * changed (the whole row), or a group deleted with the threads it left ungrouped.
 */
export const SyncTracking = Schema.Union([
	Schema.TaggedStruct("Thread", {
		threadId: Schema.String,
		priority: Schema.optionalKey(Priority),
		groupingId: Schema.optionalKey(Schema.NullOr(Schema.String)),
		ordering: Schema.optionalKey(Schema.Number),
		color: Schema.optionalKey(Schema.NullOr(Schema.String)),
	}),
	Schema.TaggedStruct("Session", { sessionId: Schema.String, color: Schema.NullOr(Schema.String) }),
	Schema.TaggedStruct("Group", Grouping.fields),
	Schema.TaggedStruct("GroupDeleted", { groupingId: Schema.String, threads: Schema.Array(Schema.String) }),
]);
export type SyncTracking = typeof SyncTracking.Type;

/** What All Threads splits an organization's threads by. */
export const ThreadsBy = Schema.Literals(["status", "priority", "grouping"]);
export type ThreadsBy = typeof ThreadsBy.Type;

/** A thread as All Threads lists it, with its machine and desktop columns. */
export const ListedThread = Schema.Struct({
	id: Schema.String,
	sessionId: Schema.String,
	originKind: Schema.Literals(["main", "fork"]),
	/** The thread a fork was cut from (a fork's, for a fork of a fork); null for a main thread. */
	originThreadId: Schema.NullOr(Schema.String),
	/** Its own title, else its nearest titled ancestor's, else what an untitled one is called. */
	title: Schema.String,
	machine: Schema.Struct({ id: Schema.String, name: Schema.String }),
	project: Schema.Struct({ id: Schema.String, name: Schema.String }),
	runState: RunState,
	status: ThreadStatus,
	priority: Priority,
	groupingId: Schema.NullOr(Schema.String),
	ordering: Schema.Number,
	/** Its own color, else its session's; null is the default. */
	color: Schema.NullOr(Schema.String),
	/** Last activity, epoch milliseconds. */
	updatedAt: Schema.Number,
});
export type ListedThread = typeof ListedThread.Type;

/** One list of All Threads: the threads with one status, one priority, or in one group (`null` is ungrouped), in `ordering`. */
export const ThreadList = Schema.Union([
	Schema.TaggedStruct("Status", { status: ThreadStatus, threads: Schema.Array(ListedThread) }),
	Schema.TaggedStruct("Priority", { priority: Priority, threads: Schema.Array(ListedThread) }),
	Schema.TaggedStruct("Grouping", {
		groupingId: Schema.NullOr(Schema.String),
		threads: Schema.Array(ListedThread),
	}),
]);
export type ThreadList = typeof ThreadList.Type;

/**
 * An organization's threads split into lists, each present even when empty: by status, by priority
 * (urgent first, none last), or by group (groups in their `ordering`, ungrouped last). The
 * organization's groups come with it, in their `ordering`, whatever the split.
 */
export const AllThreads = Schema.Struct({
	lists: Schema.Array(ThreadList),
	groups: Schema.Array(Grouping),
});
export type AllThreads = typeof AllThreads.Type;

/**
 * The topics a client follows to keep each read current; it reads again when one fires.
 * - `sidebar.list`: `sync/changed` naming a project, space, session or thread, or a removed session;
 *   every `sync/status`; `sync/tracking` for a session's color or a thread's priority.
 * - `threads.line`: `sync/changed` whose `threadId` is the thread (its entries and inbox) or that
 *   names a thread (the thread itself, or the ancestor an untitled fork takes its title from);
 *   `sync/delta/<thread>` streams its draft between checkpoints.
 * - `threads.list`: `sync/changed` naming a thread or a removed session; every `sync/status` and
 *   `sync/tracking`.
 */
export const readTopics = {
	sidebar: [syncTopics.changed, syncTopics.status, syncTopics.tracking],
	threads: [syncTopics.changed, syncTopics.status, syncTopics.tracking],
	line: (threadId: string) => [syncTopics.changed, syncTopics.delta(threadId)],
};

/** A desktop edit refused: a value out of range, or a thread, session, group or organization not found. */
export class TrackingError extends Schema.TaggedError<TrackingError>()("Server.TrackingError", {
	message: Schema.String,
}) {}

/** Package-scoped JSON storage: `package` namespaces keys so packages never collide. */
const KvKey = { package: Schema.String, key: Schema.String };

export const Api = RpcGroup.make(
	/**
	 * An organization's active projects, newest activity first, each with its sessions that are not
	 * deleted: on the default machine only, or on every machine. Read from app.db alone.
	 */
	/** A project's directories, its main checkout first; read from app.db alone. */
	Rpc.make("projects.spaces", {
		payload: { machineId: Schema.String, projectId: Schema.String },
		success: Schema.Array(ProjectSpace),
	}),
	/** Each active space's skills, its main checkout first. Never wakes a sandbox. */
	Rpc.make("projects.skills", {
		payload: { machineId: Schema.String, projectId: Schema.String },
		success: Schema.Array(SpaceSkills),
	}),
	Rpc.make("sidebar.list", {
		payload: { organizationId: Schema.String, machines: Schema.Literals(["default", "all"]) },
		success: Schema.Array(SidebarProject),
	}),
	/** One page of a thread's line with its pending inbox, read from app.db alone; below `floor`, `sync.page` first. */
	Rpc.make("threads.line", {
		payload: LineRequest,
		success: ThreadLine,
		error: SyncError,
	}),
	/** An organization's threads that are not deleted, subagents left out, split by `by` into lists in `ordering`. Read from app.db alone. */
	Rpc.make("threads.list", {
		payload: { organizationId: Schema.String, by: ThreadsBy },
		success: AllThreads,
	}),
	/** The models a new session can use; `hostDir` is its folder, whose project settings apply. */
	Rpc.make("models.list", {
		payload: { hostDir: Schema.optionalKey(Schema.String) },
		success: ModelList,
		error: Schema.Union([CodeworkUnavailable, ModelsError]),
	}),
	/** The OS home directory, and the folder `host.create` makes projects in. */
	Rpc.make("host.info", {
		success: Schema.Struct({ home: Schema.String, projects: Schema.String }),
		error: CodeworkUnavailable,
	}),
	/** The directories in `path` (a leading `~` is the OS home), hidden ones included; an unreadable one lists empty. */
	Rpc.make("host.browse", {
		payload: { path: Schema.String },
		success: Schema.Struct({ path: Schema.String, entries: Schema.Array(Folder) }),
		error: Schema.Union([CodeworkUnavailable, HostError]),
	}),
	/** A new git-initialised folder under `projects`; `commitError` says why the first commit was skipped. */
	Rpc.make("host.create", {
		payload: { name: Schema.String },
		success: Schema.Struct({ path: Schema.String, commitError: Schema.optionalKey(Schema.String) }),
		error: Schema.Union([CodeworkUnavailable, HostError]),
	}),
	/** The `origin` URL of a project's main checkout, credentials taken out; null when it has none. */
	Rpc.make("projects.remote", {
		payload: { projectId: Schema.String },
		success: Schema.Struct({ url: Schema.NullOr(Schema.String) }),
		error: Schema.Union([CodeworkUnavailable, HostError, ProjectError]),
	}),
	/** A settings file on the CodeWork server, as written. */
	Rpc.make("settings.read", {
		payload: SettingsFileRef,
		success: SettingsFile,
		error: Schema.Union(SettingsErrors),
	}),
	/** The whole file, written only when it is still at `version` and the runtime would accept it. */
	Rpc.make("settings.write", {
		payload: { ...SettingsFileRef, source: Schema.String, version: Schema.String },
		success: Schema.Struct({ version: Schema.String }),
		error: Schema.Union(SettingsErrors),
	}),
	/** One value at `at` set in place, the rest of the file kept as written; no `value` removes it. */
	Rpc.make("settings.set", {
		payload: {
			...SettingsFileRef,
			at: Schema.NonEmptyArray(Schema.Union([Schema.String, Schema.Int])),
			value: Schema.optionalKey(Schema.Unknown),
		},
		success: Schema.Struct({ version: Schema.String }),
		error: Schema.Union(SettingsErrors),
	}),
	/** Renames a project on the CodeWork server; the sidebar follows once the change syncs back. */
	Rpc.make("projects.rename", {
		payload: { projectId: Schema.String, name: Schema.Trimmed.check(Schema.isNonEmpty()) },
		success: Schema.Struct({ id: Schema.String, name: Schema.String }),
		error: Schema.Union([CodeworkUnavailable, HostError, ProjectError]),
	}),
	/** An existing folder as an absolute path; a missing one is created. */
	Rpc.make("host.add", {
		payload: { path: Schema.String },
		success: Schema.Struct({ path: Schema.String }),
		error: Schema.Union([CodeworkUnavailable, HostError]),
	}),
	/** Starts a background clone of `remote` into `path`, which must be missing or empty; `host.clones` follows it. */
	Rpc.make("host.clone", {
		payload: { remote: Schema.String, path: Schema.String },
		success: Schema.Struct({ path: Schema.String, remote: Schema.String }),
		error: Schema.Union([CodeworkUnavailable, HostError]),
	}),
	/**
	 * Every tracked clone now, then the whole list again on each change. It fails when the CodeWork
	 * server goes away; subscribe again to pick up the list it has then.
	 */
	Rpc.make("host.clones", {
		success: Schema.Array(Clone),
		error: CodeworkUnavailable,
		stream: true,
	}),
	/** Stops a running clone and empties its folder; `applied` is false when it was not running. */
	Rpc.make("host.cancel", {
		payload: { path: Schema.String },
		success: Schema.Struct({ applied: Schema.Boolean }),
		error: CodeworkUnavailable,
	}),
	/** Clones a failed or cancelled one again into its emptied folder; `applied` is false otherwise. */
	Rpc.make("host.retry", {
		payload: { path: Schema.String },
		success: Schema.Struct({ applied: Schema.Boolean }),
		error: Schema.Union([CodeworkUnavailable, HostError]),
	}),
	/** Stops tracking a clone, stopping it and emptying its folder unless it finished. */
	Rpc.make("host.discard", {
		payload: { path: Schema.String },
		success: Schema.Void,
		error: CodeworkUnavailable,
	}),
	/** Whether `gh` is installed and signed in; `hint` says what to do when it is not. */
	Rpc.make("github.status", {
		success: Schema.Struct({ ready: Schema.Boolean, hint: Schema.optionalKey(Schema.String) }),
		error: CodeworkUnavailable,
	}),
	/** A repository by `owner/name`, `host/owner/name`, its URL, or a bare name of the signed-in user's. */
	Rpc.make("github.lookup", {
		payload: { repository: Schema.String },
		success: Repository,
		error: Schema.Union([CodeworkUnavailable, HostError]),
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
	/**
	 * Every server, the built-in one first, then in the order added: as last checked, then again each
	 * time a check finds a change.
	 */
	Rpc.make("servers.watch", {
		success: Schema.Array(ServerStatus),
		stream: true,
	}),
	/** Checks every server now; done once the new statuses are out. */
	Rpc.make("servers.check", {
		success: Schema.Void,
	}),
	Rpc.make("servers.health", {
		success: ServerHealth,
	}),
	Rpc.make("servers.setHealth", {
		payload: ServerHealth,
		success: Schema.Void,
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
	/** The app reconnects through the new default's home at once; only a local server can be the default. */
	Rpc.make("servers.setDefault", {
		payload: ServerId,
		success: Schema.Void,
		error: ServersError,
	}),
	/** Runs `codework service <action>` with a local server's executable, home, arguments and variables. */
	Rpc.make("servers.service", {
		payload: { id: Schema.String, action: CliAction },
		success: Schema.Void,
		error: ServersError,
	}),
	/**
	 * Keeps a thread's detail in sync while it is open: the first open stores its newest page, a
	 * reopen resumes from where it stopped. Opens are counted; done once the detail is current, or
	 * at once while its machine is unreachable.
	 */
	Rpc.make("sync.open", {
		payload: SyncThread,
		success: Schema.Void,
	}),
	/** Stops syncing a thread's detail once every open is closed; what is stored stays. */
	Rpc.make("sync.close", {
		payload: SyncThread,
		success: Schema.Void,
	}),
	/** Stores up to `limit` entries of an opened thread's line below its floor; `floor` is the new one. */
	Rpc.make("sync.page", {
		payload: { ...SyncThread.fields, limit: Schema.Int },
		success: Schema.Struct({ entries: Schema.Int, floor: Schema.NullOr(Schema.Int) }),
		error: Schema.Union([CodeworkUnavailable, SyncError]),
	}),
	/** Sets a thread's status until its next run starts; published on `sync/status`. */
	Rpc.make("threads.setStatus", {
		payload: { threadId: Schema.String, status: ManualStatus },
		success: Schema.Void,
		error: TrackingError,
	}),
	/** `priority` must be one of `Priority`. */
	Rpc.make("threads.setPriority", {
		payload: { threadId: Schema.String, priority: Schema.Int },
		success: Schema.Void,
		error: TrackingError,
	}),
	/** A hex `#rrggbb` color over the session's; `null` falls back to it. */
	Rpc.make("threads.setColor", {
		payload: { threadId: Schema.String, color: Schema.NullOr(Schema.String) },
		success: Schema.Void,
		error: TrackingError,
	}),
	/** Puts a thread in a group of its organization; `null` ungroups it. */
	Rpc.make("threads.setGroup", {
		payload: { threadId: Schema.String, groupingId: Schema.NullOr(Schema.String) },
		success: Schema.Void,
		error: TrackingError,
	}),
	Rpc.make("threads.move", {
		payload: { threadId: Schema.String, to: Position },
		success: Schema.Void,
		error: TrackingError,
	}),
	/** A hex `#rrggbb` color; `null` is the default. */
	Rpc.make("sessions.setColor", {
		payload: { sessionId: Schema.String, color: Schema.NullOr(Schema.String) },
		success: Schema.Void,
		error: TrackingError,
	}),
	/** A new group, last in its organization. */
	Rpc.make("groups.create", {
		payload: {
			organizationId: Schema.String,
			name: Schema.String,
			color: Schema.optionalKey(Schema.NullOr(Schema.String)),
		},
		success: Grouping,
		error: TrackingError,
	}),
	/** Renames or recolors a group; an absent field is left as it is. */
	Rpc.make("groups.update", {
		payload: {
			groupingId: Schema.String,
			name: Schema.optionalKey(Schema.String),
			color: Schema.optionalKey(Schema.NullOr(Schema.String)),
		},
		success: Schema.Void,
		error: TrackingError,
	}),
	Rpc.make("groups.move", {
		payload: { groupingId: Schema.String, to: Position },
		success: Schema.Void,
		error: TrackingError,
	}),
	/** Its threads are left ungrouped. */
	Rpc.make("groups.delete", {
		payload: { groupingId: Schema.String },
		success: Schema.Void,
		error: TrackingError,
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
