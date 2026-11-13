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
	/** The thread that wrote it: this one, or a source it was forked from. */
	threadId: Schema.String,
	seq: Schema.Int,
	role: Schema.Literals(["user", "assistant"]),
	/** `draft` is a reply still streaming; `aborted` one that was interrupted. */
	state: Schema.Literals(["committed", "draft", "aborted"]),
	/** Epoch milliseconds. */
	createdAt: Schema.Finite,
	/** Epoch milliseconds of the last change; for a reply, when it ended once it is no longer a draft. */
	updatedAt: Schema.Finite,
	parts: Schema.Array(Part),
	/** Bytes of its parts as the harness stores them; `thread.sync`'s budget counts it. */
	size: Schema.Int,
	/** Why a reply failed, as `provider/model: reason`; absent for one that ended normally or was stopped. */
	error: Schema.optionalKey(Schema.String),
});
export type HistoryEntry = typeof HistoryEntry.Type;

/** How hard a model reasons, ascending. */
export const ThinkingLevel = Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = typeof ThinkingLevel.Type;

/** One logical codebase, whatever env it is checked out in. */
export const ProjectInfo = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	status: Schema.Literals(["active", "archived"]),
	/** Epoch milliseconds. */
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
});
export type ProjectInfo = typeof ProjectInfo.Type;

/** One directory of a project in one env; sessions attach to it. */
export const SpaceInfo = Schema.Struct({
	id: Schema.String,
	projectId: Schema.String,
	location: Schema.String,
	kind: Schema.Literals(["primary", "linked", "copy", "plain"]),
	/** The sandbox it is in; absent for the host. */
	env: Schema.optionalKey(Schema.String),
	status: Schema.Literals(["active", "archived"]),
	/** Epoch milliseconds. */
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
});
export type SpaceInfo = typeof SpaceInfo.Type;

export const SessionInfo = Schema.Struct({
	id: Schema.String,
	spaceId: Schema.String,
	slug: Schema.String,
	directory: Schema.String,
	hostDir: Schema.optionalKey(Schema.String),
	/** The sandbox the session runs in; absent for the host itself. */
	sandbox: Schema.optionalKey(Schema.Struct({ driver: Schema.String })),
	project: Schema.optionalKey(Schema.Struct({ id: Schema.String, name: Schema.String })),
	tag: Schema.optionalKey(Schema.String),
	metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	/** Epoch milliseconds. */
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
	/** Where unaddressed prompts go. */
	mainThreadId: Schema.String,
});
export type SessionInfo = typeof SessionInfo.Type;

/** `cut` is the committed seq of `entryId`: the inherited line ends there. */
export const ThreadOrigin = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("main") }),
	Schema.Struct({ kind: Schema.Literal("fork"), threadId: Schema.String, entryId: Schema.String, cut: Schema.Int }),
	Schema.Struct({
		kind: Schema.Literal("subagent"),
		threadId: Schema.String,
		callId: Schema.String,
		entryId: Schema.optionalKey(Schema.String),
		/** Present once `entryId` is committed. */
		cut: Schema.optionalKey(Schema.Int),
	}),
]);
export type ThreadOrigin = typeof ThreadOrigin.Type;

/** Billed usage of a thread's own entries; a fork's inherited entries count for their source. */
export const ThreadUsage = Schema.Struct({
	/** Total cost in US dollars. */
	cost: Schema.Finite,
	input: Schema.Int,
	output: Schema.Int,
	cacheRead: Schema.Int,
	cacheWrite: Schema.Int,
});
export type ThreadUsage = typeof ThreadUsage.Type;

/** Where a thread's run is, as the harness stores it. */
export const RunState = Schema.Literals(["idle", "starting", "running"]);
export type RunState = typeof RunState.Type;

export const RunOutcome = Schema.Literals(["succeeded", "failed", "interrupted"]);
export type RunOutcome = typeof RunOutcome.Type;

/** Why the last run did not succeed. */
export const RunError = Schema.Union([
	Schema.TaggedStruct("failed", {
		error: Schema.Struct({ type: Schema.String, message: Schema.String, status: Schema.optionalKey(Schema.Int) }),
	}),
	Schema.TaggedStruct("runFailed", {
		reason: Schema.Literals(["crashloop", "interrupted", "truncated"]),
		message: Schema.String,
	}),
	Schema.TaggedStruct("interrupted", { reason: Schema.Literals(["user", "shutdown", "crash"]) }),
]);
export type RunError = typeof RunError.Type;

/**
 * The last run of a thread; `error` is set unless it succeeded. While the run is still going it is
 * set only to the user's stop that run was asked for, until its end lands.
 */
export const ThreadRun = Schema.Struct({
	/** Epoch milliseconds. */
	startedAt: Schema.Finite,
	endedAt: Schema.optionalKey(Schema.Finite),
	outcome: Schema.optionalKey(RunOutcome),
	error: Schema.optionalKey(RunError),
});
export type ThreadRun = typeof ThreadRun.Type;

/** Whether the thread's open run was asked to stop by the user: `session.execution.stopping` landed, its end not yet. */
export const stopping = (thread: { readonly runState: RunState; readonly lastRun?: ThreadRun }) =>
	thread.runState !== "idle" &&
	thread.lastRun?.error?._tag === "interrupted" &&
	thread.lastRun.error.reason === "user";

const ThreadFields = {
	id: Schema.String,
	origin: ThreadOrigin,
	/** Absent until its first own prompt; a fork shows its source's title until then. */
	title: Schema.optionalKey(Schema.String),
	updatedAt: Schema.Finite,
	model: Schema.optionalKey(Schema.Struct({ provider: Schema.String, id: Schema.String })),
	/** The thinking level chosen for this thread; absent when settings decide. */
	thinkingLevel: Schema.optionalKey(ThinkingLevel),
	/** The prompt foundation chosen for this thread; absent when prompt plugins render it. */
	foundation: Schema.optionalKey(Schema.String),
	/** Where it runs instead of the session's space and directory. */
	placement: Schema.optionalKey(Schema.Struct({ spaceId: Schema.String, directory: Schema.String })),
	usage: ThreadUsage,
	runState: RunState,
	/** When `runState` last changed, epoch milliseconds; absent before the first run. */
	runStateAt: Schema.optionalKey(Schema.Finite),
	/** Absent before the first run. */
	lastRun: Schema.optionalKey(ThreadRun),
	/** Whether it holds queued prompts that wait for its next prompt instead of running by themselves. */
	parked: Schema.Boolean,
	/** Automatic restarts of the current run. */
	restarts: Schema.Int,
	/** The 1-based provider request in flight; absent when none is. */
	attempt: Schema.optionalKey(Schema.Int),
	/** The seq of the session event that created it. */
	createdSeq: Schema.Int,
	/** Epoch milliseconds. */
	createdAt: Schema.Finite,
};

/** One linear transcript of a session, with the session embedded. */
export const ThreadInfo = Schema.Struct({ ...ThreadFields, session: SessionInfo });
export type ThreadInfo = typeof ThreadInfo.Type;

/** A thread as `index.sync` sends it: its session is a row of its own. */
export const ThreadSummary = Schema.Struct({ ...ThreadFields, sessionId: Schema.String });
export type ThreadSummary = typeof ThreadSummary.Type;

/** An `index.sync` item: a row with the revision that last wrote it, a deletion, or progress. */
export const IndexItem = Schema.Union([
	Schema.TaggedStruct("Project", { project: ProjectInfo, rev: Schema.Int }),
	Schema.TaggedStruct("Space", { space: SpaceInfo, rev: Schema.Int }),
	Schema.TaggedStruct("Session", { session: SessionInfo, rev: Schema.Int }),
	Schema.TaggedStruct("Thread", { thread: ThreadSummary, rev: Schema.Int }),
	Schema.TaggedStruct("Removed", { kind: Schema.Literal("session"), id: Schema.String, rev: Schema.Int }),
	/** Every row with a revision up to `rev` has been sent. */
	Schema.TaggedStruct("Synced", { storeId: Schema.String, rev: Schema.Int }),
]);
export type IndexItem = typeof IndexItem.Type;

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
	/** The thread's sequence number at admission; orders the queue. */
	admittedSeq: Schema.Int,
	/** Epoch milliseconds. */
	createdAt: Schema.Finite,
});
export type QueuedPrompt = typeof QueuedPrompt.Type;

/** Text streamed into a reply's part since its last checkpoint; never stored. */
export const LiveDelta = Schema.Struct({
	/** The reply's entry id. */
	entryId: Schema.String,
	partIndex: Schema.Int,
	kind: Schema.Literals(["text", "thinking"]),
	/** The part's text length before this delta: apply it only where the held text ends there. */
	offset: Schema.Int,
	delta: Schema.String,
});
export type LiveDelta = typeof LiveDelta.Type;

/** A `thread.sync` item: a row with the revision that last wrote it, progress, or a live delta. */
export const ThreadItem = Schema.Union([
	/** Upsert by entry id. */
	Schema.TaggedStruct("Entry", { entry: HistoryEntry, rev: Schema.Int }),
	Schema.TaggedStruct("Inbox", {
		prompt: QueuedPrompt,
		state: Schema.Literals(["pending", "promoted", "cancelled"]),
		rev: Schema.Int,
	}),
	/** Every row with a revision up to `rev` has been sent; `floor`, on the first, is the oldest entry's seq. */
	Schema.TaggedStruct("Synced", { storeId: Schema.String, rev: Schema.Int, floor: Schema.optionalKey(Schema.Int) }),
	Schema.TaggedStruct("Delta", { delta: LiveDelta }),
]);
export type ThreadItem = typeof ThreadItem.Type;

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

/**
 * What `model.list` answers: the usable providers, and the model a session runs when none is chosen,
 * absent when settings name none and no provider is configured.
 */
export const ModelList = Schema.Struct({
	providers: Schema.Array(ModelProvider),
	default: Schema.optionalKey(
		Schema.Struct({
			provider: Schema.String,
			id: Schema.String,
			thinkingLevel: ThinkingLevel,
			/** Display names from the catalog, present even when its provider is not listed. */
			name: Schema.optionalKey(Schema.String),
			providerName: Schema.optionalKey(Schema.String),
		}),
	),
});
export type ModelList = typeof ModelList.Type;

/** A settings file could not be read or decoded. */
export class SettingsError extends Schema.TaggedError<SettingsError>()("SettingsError", {
	path: Schema.String,
	detail: Schema.String,
}) {}

/** A settings file changed since it was read. */
export class SettingsConflictError extends Schema.TaggedError<SettingsConflictError>()("SettingsConflictError", {
	path: Schema.String,
}) {}

/** The project has no main checkout on the server's host. */
export class ProjectCheckoutError extends Schema.TaggedError<ProjectCheckoutError>()("ProjectCheckoutError", {
	projectId: Schema.String,
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

/** A host folder operation that failed: unreadable, not a directory, taken, or git/gh refused. */
export class ProjectNotFoundError extends Schema.TaggedError<ProjectNotFoundError>()("ProjectNotFoundError", {
	projectId: Schema.String,
}) {}

export class HostError extends Schema.TaggedError<HostError>()("Server.HostError", {
	message: Schema.String,
}) {}

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
	HostError,
]);
export type CreateError = typeof CreateError.Type;

/** A directory on the host, by its name and absolute path. */
export const Folder = Schema.Struct({ name: Schema.String, path: Schema.String });
export type Folder = typeof Folder.Type;

/** A GitHub repository as `gh` names it, with its web and SSH clone URLs. */
export const Repository = Schema.Struct({ nameWithOwner: Schema.String, url: Schema.String, sshUrl: Schema.String });
export type Repository = typeof Repository.Type;

export const CloneStage = Schema.Literals(["connecting", "counting", "receiving", "resolving", "checkout"]);
export type CloneStage = typeof CloneStage.Type;

export const ClonePhase = Schema.Literals(["running", "done", "failed", "cancelled"]);
export type ClonePhase = typeof ClonePhase.Type;

/** A tracked clone; `path` (the absolute destination) is its id. */
export const Clone = Schema.Struct({
	path: Schema.String,
	/** Credentials and query stripped. */
	remote: Schema.String,
	phase: ClonePhase,
	stage: CloneStage,
	/** 0 to 100 within `stage`, when git prints one. */
	percent: Schema.NullOr(Schema.Int),
	/** Git's transfer note, such as its speed; at most 200 characters. */
	detail: Schema.NullOr(Schema.String),
	/** Git has printed no progress for 20 seconds. */
	stalled: Schema.Boolean,
	/** Why it failed; at most 1000 characters. */
	error: Schema.NullOr(Schema.String),
	/** Epoch milliseconds. */
	startedAt: Schema.Finite,
	endedAt: Schema.NullOr(Schema.Finite),
	/** Bumped on every change across all clones; a higher one is newer. */
	sequence: Schema.Int,
});
export type Clone = typeof Clone.Type;

/** A thread of a session; the session's main thread when `threadId` is absent. */
const ThreadRef = { sessionId: Schema.String, threadId: Schema.optionalKey(Schema.String) };

/** The server's "no such thread" (the harness `ThreadNotFoundError`), by its wire tag. */
export class ThreadNotFoundError extends Schema.TaggedError<ThreadNotFoundError>()("ThreadNotFoundError", {
	threadId: Schema.String,
}) {}

const ThreadError = Schema.Union([SessionNotFoundError, ThreadNotFoundError]);

/** The server's "cannot fork there" (the harness `ForkError`), by its wire tag. */
export class ForkError extends Schema.TaggedError<ForkError>()("ForkError", {
	threadId: Schema.String,
	entryId: Schema.String,
	reason: Schema.String,
}) {}

/** A settings file: `settings.jsonc` or `mcp.json`, the project's with `projectId`, else the user's. */
const SettingsFileRef = {
	projectId: Schema.optionalKey(Schema.String),
	file: Schema.Literals(["settings", "mcp"]),
};
/** The settings a project's `settings.jsonc` falls back to, as the page shows them. */
const Inherited = Schema.Struct({
	retry: Schema.Struct({ maxRetries: Schema.Int, baseDelayMs: Schema.Int, maxDelayMs: Schema.Int }),
});
const SettingsFileErrors = Schema.Union([SettingsError, ProjectNotFoundError, ProjectCheckoutError]);

export const Api = RpcGroup.make(
	Rpc.make("server.info", {
		payload: {},
		success: Schema.Struct({
			pid: Schema.Int,
			version: Schema.String,
			/** The harness store this server serves; a sync cursor is only valid against it. */
			storeId: Schema.String,
			/** The store's head: the last revision taken. */
			rev: Schema.Int,
		}),
	}),
	/**
	 * Every project, space, session and thread whose revision is past `after`, in revision order,
	 * then `Synced`; then the same live after each commit. `after: 0` reads the whole index.
	 */
	Rpc.make("index.sync", {
		payload: { after: Schema.Int },
		success: IndexItem,
		stream: true,
	}),
	/**
	 * One thread's detail. Without `after`, the newest entries of its line within `budget` bytes and
	 * its pending inbox, then `Synced` with `floor`; with `after`, its own rows past it. Then the same
	 * live, with its text and thinking deltas between.
	 */
	Rpc.make("thread.sync", {
		payload: {
			sessionId: Schema.String,
			threadId: Schema.String,
			after: Schema.optionalKey(Schema.Int),
			budget: Schema.optionalKey(Schema.Int),
		},
		success: ThreadItem,
		error: Schema.Union([ThreadError, SubscriptionOverflowError, EventEncodingError]),
		stream: true,
	}),
	/** Older entries of a thread's line, oldest first: the newest `limit` below `before`, cut to `budget` bytes. */
	Rpc.make("thread.page", {
		payload: {
			sessionId: Schema.String,
			threadId: Schema.String,
			before: Schema.Int,
			limit: Schema.Int,
			budget: Schema.optionalKey(Schema.Int),
		},
		success: Schema.Struct({ entries: Schema.Array(HistoryEntry) }),
		error: ThreadError,
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
	/** The `origin` URL of a project's main checkout on the host, credentials taken out; null when there is none. */
	Rpc.make("project.remote", {
		payload: { projectId: Schema.String },
		success: Schema.Struct({ url: Schema.NullOr(Schema.String) }),
		error: ProjectNotFoundError,
	}),
	/** Renames a project. Trimmed, non-empty. */
	Rpc.make("project.rename", {
		payload: { projectId: Schema.String, name: Schema.String },
		success: Schema.Struct({ id: Schema.String, name: Schema.String }),
		error: ProjectNotFoundError,
	}),
	/** A settings file as written: the project's with `projectId`, else the user's; `error` is what the runtime would reject. */
	Rpc.make("settings.read", {
		payload: SettingsFileRef,
		success: Schema.Struct({
			path: Schema.String,
			source: Schema.String,
			exists: Schema.Boolean,
			version: Schema.String,
			/** The file's JSONC as a value; absent when it does not parse. */
			value: Schema.optionalKey(Schema.Unknown),
			error: Schema.optionalKey(Schema.String),
			/**
			 * For `settings.jsonc`: what applies where this file sets nothing -- the user's settings over the
			 * defaults for a project's file, the defaults for the user's. Absent when a lower file is broken.
			 */
			inherited: Schema.optionalKey(Inherited),
			/** For `mcp.json`: the servers as sessions use them, user and project merged. */
			servers: Schema.optionalKey(
				Schema.Array(
					Schema.Struct({
						name: Schema.String,
						from: Schema.Literals(["user", "project"]),
						enabled: Schema.Boolean,
					}),
				),
			),
		}),
		error: SettingsFileErrors,
	}),
	/** The whole file, written only when it is still at `version` and the runtime would accept it. */
	Rpc.make("settings.write", {
		payload: { ...SettingsFileRef, source: Schema.String, version: Schema.String },
		success: Schema.Struct({ version: Schema.String }),
		error: Schema.Union([SettingsFileErrors, SettingsConflictError]),
	}),
	/** One value at `at` set in place; no `value` removes it. */
	Rpc.make("settings.set", {
		payload: {
			...SettingsFileRef,
			at: Schema.NonEmptyArray(Schema.Union([Schema.String, Schema.Int])),
			value: Schema.optionalKey(Schema.Unknown),
		},
		success: Schema.Struct({ version: Schema.String }),
		error: SettingsFileErrors,
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
	/** A new thread whose history continues from this one's line through `entryId`, which must be committed. */
	Rpc.make("thread.fork", {
		payload: { ...ThreadRef, entryId: Schema.String },
		success: Schema.Struct({ thread: ThreadInfo }),
		error: Schema.Union([ThreadError, ForkError]),
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
	/**
	 * Durable events after `after` (exclusive), then `log.synced`; with `follow`, each new one as it
	 * commits. Every thread's, or only `threadId`'s; the marker names the session's head either way.
	 */
	Rpc.make("session.log", {
		payload: {
			sessionId: Schema.String,
			threadId: Schema.optionalKey(Schema.String),
			after: Schema.optionalKey(Schema.Int),
			follow: Schema.optionalKey(Schema.Boolean),
		},
		success: Schema.Union([EventEnvelope, LogSynced]),
		error: Schema.Union([SessionNotFoundError, EventEncodingError]),
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
	/** Stops the thread; the session's other threads keep running. The main thread when `threadId` is absent. */
	Rpc.make("thread.interrupt", {
		payload: ThreadRef,
		success: Schema.Struct({ interrupted: Schema.Boolean }),
		error: ThreadError,
	}),
	/** The OS home directory, and the folder `host.create` makes projects in. */
	Rpc.make("host.info", {
		payload: {},
		success: Schema.Struct({ home: Schema.String, projects: Schema.String }),
	}),
	/** The directories in `path` (a leading `~` is the OS home), hidden ones included; an unreadable one lists empty. */
	Rpc.make("host.browse", {
		payload: { path: Schema.String },
		success: Schema.Struct({ path: Schema.String, entries: Schema.Array(Folder) }),
		error: HostError,
	}),
	/** A new git-initialised folder under `projects`; `commitError` says why the first commit was skipped. */
	Rpc.make("host.create", {
		payload: { name: Schema.String },
		success: Schema.Struct({ path: Schema.String, commitError: Schema.optionalKey(Schema.String) }),
		error: HostError,
	}),
	/** An existing folder as an absolute path; a missing one is created. */
	Rpc.make("host.add", {
		payload: { path: Schema.String },
		success: Schema.Struct({ path: Schema.String }),
		error: HostError,
	}),
	/** Starts a background clone of `remote` into `path`, which must be missing or empty; `host.clones` follows it. */
	Rpc.make("host.clone", {
		payload: { remote: Schema.String, path: Schema.String },
		success: Schema.Struct({ path: Schema.String, remote: Schema.String }),
		error: HostError,
	}),
	/** Every tracked clone now, then the whole list again on each change. */
	Rpc.make("host.clones", {
		payload: {},
		success: Schema.Array(Clone),
		stream: true,
	}),
	/** Stops a running clone and empties its folder; `applied` is false when it was not running. */
	Rpc.make("host.cancel", {
		payload: { path: Schema.String },
		success: Schema.Struct({ applied: Schema.Boolean }),
	}),
	/** Clones a failed or cancelled one again into its emptied folder; `applied` is false otherwise. */
	Rpc.make("host.retry", {
		payload: { path: Schema.String },
		success: Schema.Struct({ applied: Schema.Boolean }),
		error: HostError,
	}),
	/** Stops tracking a clone, stopping it and emptying its folder unless it finished. */
	Rpc.make("host.discard", {
		payload: { path: Schema.String },
		success: Schema.Void,
	}),
	/** Whether `gh` is installed and signed in; `hint` says what to do when it is not. */
	Rpc.make("github.status", {
		payload: {},
		success: Schema.Struct({ ready: Schema.Boolean, hint: Schema.optionalKey(Schema.String) }),
	}),
	/** A repository by `owner/name`, `host/owner/name`, its URL, or a bare name of the signed-in user's. */
	Rpc.make("github.lookup", {
		payload: { repository: Schema.String },
		success: Repository,
		error: HostError,
	}),
	/** The sandboxes CodeWork knows, from its own store: listing them never wakes one. */
	Rpc.make("sandbox.list", {
		payload: {},
		success: Schema.Array(
			Schema.Struct({
				id: Schema.String,
				driver: Schema.String,
				providerResourceId: Schema.OptionFromNullOr(Schema.String),
				status: Schema.String,
			}),
		),
	}),
	/**
	 * Calls a method of a space daemon running in `spaceId` (such as the git daemon's `diff`). Never
	 * starts a daemon or wakes a sandbox: `unavailable` when none runs there, `detached` when the space
	 * is not mounted.
	 */
	Rpc.make("daemon.call", {
		payload: {
			plugin: Schema.String,
			spaceId: Schema.String,
			method: Schema.String,
			input: Schema.optional(Schema.Unknown),
		},
		success: Schema.Unknown,
		error: Schema.TaggedStruct("DaemonCallError", {
			reason: Schema.Literals([
				"unavailable",
				"detached",
				"method_not_found",
				"invalid_input",
				"invalid_output",
				"failed",
			]),
			message: Schema.String,
		}),
	}),
	/**
	 * Every event as it happens, durable and live-only alike (text deltas, execution state), after a
	 * `server.connected` frame. With `types`, only those, and first the last event of each that a space
	 * daemon published; otherwise nothing is replayed: what a reader misses while away is gone.
	 */
	Rpc.make("event.subscribe", {
		payload: { types: Schema.optional(Schema.Array(Schema.String)) },
		success: EventEnvelope,
		error: Schema.Union([SubscriptionOverflowError, EventEncodingError]),
		stream: true,
	}),
);

export * as Codework from "./codework.ts";
