import { Model } from "@codeworksh/aikit";
import {
	Control,
	Event,
	EventList,
	Location,
	McpError,
	optional,
	Project,
	Skill,
	PromptSchema,
	Runner,
	Sandbox,
	SandboxError,
	Session,
	SessionStore,
	Settings,
	SettingsFile,
	ThreadSchema,
	ThreadStore,
} from "@codeworksh/harness/effect";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { EncodingError, EventEnvelope } from "./envelope.ts";
import { Part } from "./part.ts";

/** The HTTP path the RPC endpoint is served on; the version moves with breaking wire changes. */
export const path = "/rpc/v1";

export const SandboxInfo = Schema.Struct({
	id: Sandbox.SandboxInstance.ID,
	driver: Schema.String,
	kind: Sandbox.SandboxInstance.Kind,
	providerResourceId: Schema.OptionFromNullOr(Schema.String),
	ownership: Sandbox.SandboxInstance.Ownership,
	status: Sandbox.SandboxInstance.Status,
	usage: Sandbox.SandboxInstance.Usage,
	refCount: Schema.Int,
	createdAt: Schema.DateFromString,
	updatedAt: Schema.DateFromString,
});
export type SandboxInfo = typeof SandboxInfo.Type;

/** One logical codebase, whatever env it is checked out in. */
const ProjectInfo = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	status: Schema.Literals(["active", "archived"]),
	/** Epoch milliseconds. */
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
});
export type ProjectInfo = typeof ProjectInfo.Type;

/** One directory of a project in one env; sessions attach to it. */
const SpaceInfo = Schema.Struct({
	id: Schema.String,
	projectId: Schema.String,
	location: Session.AbsolutePath,
	kind: Schema.Literals(["primary", "linked", "copy", "plain"]),
	/** The sandbox it is in; absent for the host. */
	env: optional(Schema.String),
	status: Schema.Literals(["active", "archived"]),
	/** Epoch milliseconds. */
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
});
export type SpaceInfo = typeof SpaceInfo.Type;

/** The container: where its threads run by default, and which host project it reads. */
export const SessionInfo = Schema.Struct({
	id: Session.SessionSchema.ID,
	spaceId: Schema.String,
	slug: Schema.String,
	directory: Session.AbsolutePath,
	/** The host directory this session is anchored to. Absent when it has none. */
	hostDir: optional(Session.AbsolutePath),
	sandbox: optional(SandboxInfo),
	/** The project the session's space belongs to. */
	project: optional(Schema.Struct({ id: Schema.String, name: Schema.String })),
	tag: optional(Schema.String),
	metadata: optional(Schema.Record(Schema.String, Schema.String)),
	/** Epoch milliseconds. */
	createdAt: Schema.Finite,
	/** Last activity in any of its threads, epoch milliseconds. */
	updatedAt: Schema.Finite,
	/** Where unaddressed prompts go. */
	mainThreadId: ThreadSchema.ID,
});
export type SessionInfo = typeof SessionInfo.Type;

/** `cut` is the committed seq of `entryId`: the inherited line ends there. */
const ThreadOrigin = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("main") }),
	Schema.Struct({ kind: Schema.Literal("fork"), threadId: Schema.String, entryId: Schema.String, cut: Schema.Int }),
	Schema.Struct({
		kind: Schema.Literal("subagent"),
		threadId: Schema.String,
		callId: Schema.String,
		entryId: optional(Schema.String),
		/** Present once `entryId` is committed. */
		cut: optional(Schema.Int),
	}),
]);

/** Billed usage of a thread's own entries; what it inherits through a fork point counts for its source. */
const ThreadUsage = Schema.Struct({
	/** Total cost in US dollars, from the catalog's prices. */
	cost: Schema.Finite,
	input: Schema.Int,
	output: Schema.Int,
	cacheRead: Schema.Int,
	cacheWrite: Schema.Int,
});
export type ThreadUsage = typeof ThreadUsage.Type;

/** The last run of a thread; `error` is set unless it succeeded or is still going. */
const ThreadRun = Schema.Struct({
	/** Epoch milliseconds. */
	startedAt: Schema.Finite,
	endedAt: optional(Schema.Finite),
	outcome: optional(ThreadSchema.RunOutcome),
	error: optional(ThreadSchema.RunError),
});

const ThreadFields = {
	id: ThreadSchema.ID,
	origin: ThreadOrigin,
	/** Absent until its first own prompt; clients show a fork's source title until then. */
	title: optional(Schema.String),
	/** Last activity, epoch milliseconds. */
	updatedAt: Schema.Finite,
	/** The model chosen for this thread; absent when settings decide. */
	model: optional(Schema.Struct({ provider: Schema.String, id: Schema.String })),
	/** The thinking level chosen for this thread; absent when settings decide. */
	thinkingLevel: optional(Schema.Enum(Model.ThinkingLevelEnum)),
	/** The prompt foundation chosen for this thread; absent when prompt plugins render it. */
	foundation: optional(Schema.String),
	/** Where it runs instead of the session's space and directory. */
	placement: optional(Schema.Struct({ spaceId: Schema.String, directory: Session.AbsolutePath })),
	usage: ThreadUsage,
	/** Where its run is, as the harness stores it: live whenever the server is up. */
	runState: ThreadSchema.RunState,
	/** When `runState` last changed, epoch milliseconds; absent before the first run. */
	runStateAt: optional(Schema.Finite),
	/** Absent before the first run. */
	lastRun: optional(ThreadRun),
	/** Whether it holds queued prompts that wait for its next prompt instead of running by themselves. */
	parked: Schema.Boolean,
	/** Automatic restarts of the current run. */
	restarts: Schema.Int,
	/** The 1-based provider request in flight; absent when none is. */
	attempt: optional(Schema.Int),
	/** The seq of the session event that created it. */
	createdSeq: Schema.Int,
	/** Epoch milliseconds. */
	createdAt: Schema.Finite,
};

/** One linear transcript of a session, with the session embedded. */
export const ThreadInfo = Schema.Struct({ ...ThreadFields, session: SessionInfo });
export type ThreadInfo = typeof ThreadInfo.Type;

/** A thread as `index.sync` sends it: its session is a row of its own. */
export const ThreadSummary = Schema.Struct({ ...ThreadFields, sessionId: Session.SessionSchema.ID });
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

/** A thread of a session: `threadId`, or the session's `main` thread when absent. */
const ThreadRef = {
	sessionId: Session.SessionSchema.ID,
	threadId: optional(ThreadSchema.ID),
};

/** A thread's MCP server, by the name its `mcp.json` gives it. */
const McpServerRef = { ...ThreadRef, server: Schema.String };

/** One message in a thread's line (inherited ones first), oldest first. */
export const HistoryEntry = Schema.Struct({
	/** The entry id: what live events and `thread.message` refer to. */
	id: Schema.String,
	/** The thread that wrote it: this one, or a source it was forked from. */
	threadId: Schema.String,
	/** Its place in the session's durable log; live events continue from it. */
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
	error: optional(Schema.String),
});
export type HistoryEntry = typeof HistoryEntry.Type;

/** A prompt admitted but not yet in the conversation: a steer waiting for the next model request, or a follow-up for the next turn. */
export const QueuedPrompt = Schema.Struct({
	/** The id of the user message it becomes once promoted. */
	id: Schema.String,
	delivery: PromptSchema.Delivery,
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
	Schema.TaggedStruct("Synced", { storeId: Schema.String, rev: Schema.Int, floor: optional(Schema.Int) }),
	Schema.TaggedStruct("Delta", { delta: LiveDelta }),
]);
export type ThreadItem = typeof ThreadItem.Type;

/** Ends `session.log`'s replay; `seq` is absent when the session has no durable events yet. */
export const LogSynced = Schema.Struct({
	type: Schema.Literal("log.synced"),
	/** The session the log was read for. */
	aggregateId: Schema.String,
	seq: optional(Schema.Int),
});
export type LogSynced = typeof LogSynced.Type;

/** A thread's model, thinking and foundation choices: a given field replaces the stored one, `null` clears it. */
export const RuntimeConfig = Schema.Struct({
	model: optional(Schema.NullOr(Schema.Struct({ provider: Schema.String, id: Schema.String }))),
	thinkingLevel: optional(Schema.NullOr(Schema.Enum(Model.ThinkingLevelEnum))),
	foundation: optional(Schema.NullOr(Schema.NonEmptyString)),
});
export type RuntimeConfig = typeof RuntimeConfig.Type;

const SandboxRef = Sandbox.Selection;

/** A model to choose, by the catalog's id and display name, with the thinking levels it supports. */
const ModelOption = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	/** In ascending order; `["off"]` for a model that does not reason. */
	thinkingLevels: Schema.Array(Schema.Enum(Model.ThinkingLevelEnum)),
});

/** A provider this server can call, with the models a session may use from it. */
const ModelProvider = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	models: Schema.Array(ModelOption),
});
export type ModelProvider = typeof ModelProvider.Type;

/** A project's name as a client sets it: trimmed, never empty. */
const ProjectName = Schema.Trimmed.check(Schema.isNonEmpty());

export class OAuthError extends Schema.TaggedError<OAuthError>()("Server.OAuthError", {
	message: Schema.String,
}) {}

/** OAuth providers whose credentials this server stores. */
export const OAuthProvider = Schema.Literals(["openai-codex", "github-copilot"]);
export type OAuthProvider = typeof OAuthProvider.Type;

/**
 * Credentials as the provider's aikit module persists them. The union is
 * discriminated by `provider` so one set of RPCs serves every login.
 */
export const OAuthCredentials = Schema.Union([
	Schema.Struct({
		provider: Schema.Literal("openai-codex"),
		access: Schema.String,
		refresh: Schema.String,
		expires: Schema.Finite,
		accountId: Schema.String,
	}),
	Schema.Struct({
		provider: Schema.Literal("github-copilot"),
		access: Schema.String,
		refresh: Schema.String,
		expires: Schema.Finite,
		enterpriseUrl: optional(Schema.String),
		apiEndpoint: optional(Schema.String),
		availableModelIds: optional(Schema.Array(Schema.String)),
	}),
]);
export type OAuthCredentials = typeof OAuthCredentials.Type;

/** What a login looks like from the outside: never the tokens themselves. */
export const OAuthInfo = Schema.Struct({
	provider: OAuthProvider,
	/** Epoch millis, or 0 for a credential that does not expire. */
	expires: Schema.Finite,
	accountId: optional(Schema.String),
	apiEndpoint: optional(Schema.String),
	enterpriseUrl: optional(Schema.String),
	availableModels: optional(Schema.Int),
});
export type OAuthInfo = typeof OAuthInfo.Type;

/** A host folder operation that failed: unreadable, not a directory, taken, or git/gh refused. */
export class HostError extends Schema.TaggedError<HostError>()("Server.HostError", {
	message: Schema.String,
}) {}

/** A directory on the host, by its name and absolute path. */
export const Folder = Schema.Struct({ name: Schema.String, path: Schema.String });
export type Folder = typeof Folder.Type;

/** A GitHub repository as `gh` names it, with its web and SSH clone URLs. */
export const Repository = Schema.Struct({ nameWithOwner: Schema.String, url: Schema.String, sshUrl: Schema.String });
export type Repository = typeof Repository.Type;

export const CloneStage = Schema.Literals(["connecting", "counting", "receiving", "resolving", "checkout"]);
export type CloneStage = typeof CloneStage.Type;

const ClonePhase = Schema.Literals(["running", "done", "failed", "cancelled"]);
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

const SessionErrors = Schema.Union([
	SessionStore.SessionNotFoundError,
	ThreadStore.ThreadNotFoundError,
	SessionStore.SessionLinkedSpaceNotFoundError,
	SessionStore.RelinkError,
]);

const ThreadErrors = Schema.Union([SessionStore.SessionNotFoundError, ThreadStore.ThreadNotFoundError]);

// Every lifecycle error the sandbox control plane can raise; narrowing per
// endpoint would misreport what `withMount` and `stop` actually fail with.
const SandboxErrors = Schema.Union([
	SandboxError.SandboxNotFoundError,
	SandboxError.SandboxDriverNotRegisteredError,
	SandboxError.SandboxDriverRegistrationError,
	SandboxError.SandboxUnsupportedError,
	SandboxError.SandboxProviderError,
	SandboxError.SandboxUnavailError,
	SandboxError.SandboxRemovedError,
	SandboxError.SandboxTransitionConflictError,
	SandboxError.SandboxBusyError,
]);

const LocationErrors = Schema.Union([Location.DirectoryNotFoundError, Location.NotDirectoryError]);

/** One of a thread's MCP servers as that thread sees it. */
const McpStatus = Schema.Struct({
	server: Schema.String,
	state: EventList.McpState,
	error: optional(Schema.String),
	/** Tools the server offered when last listed, each with its exposure in the thread. */
	tools: Schema.Array(
		Schema.Struct({ name: Schema.String, exposure: Schema.Literals(["direct", "codemode", "deferred", "hidden"]) }),
	),
	resources: Schema.Boolean,
	/** Tools it listed last that were left out because the MCP SDK rejects them; absent when none were. */
	skipped: optional(EventList.McpSkipped),
});
export type McpStatus = typeof McpStatus.Type;

const McpErrors = Schema.Union([ThreadErrors, McpError.UnknownServerError]);

const SettingsFileRef = { projectId: optional(Schema.String), file: Schema.Literals(["settings", "mcp"]) };
/** The settings a project's `settings.jsonc` falls back to, as the page shows them. */
const Inherited = Schema.Struct({
	retry: Schema.Struct({ maxRetries: Schema.Int, baseDelayMs: Schema.Int, maxDelayMs: Schema.Int }),
});
const SettingsFileErrors = Schema.Union([
	Settings.SettingsError,
	Project.ProjectNotFoundError,
	Project.ProjectCheckoutError,
]);

export const Api = RpcGroup.make(
	/**
	 * The server's own identity: the process and build a client is talking to.
	 *
	 * The health probe: a discovery registration names a pid and version, and a
	 * caller confirms the process answering is the one that registered before it
	 * trusts the endpoint. Like every other capability it rides the RPC channel,
	 * so there is no separate HTTP surface to keep in step.
	 */
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
	 * The index of this machine: every project, space, session and thread whose revision is past
	 * `after`, in revision order, then `Synced` at the head read when the call began; then the same
	 * live after each commit. `after: 0` reads the whole index. A row written again moves to a later
	 * revision and is sent again; the latest wins. A deleted session arrives as `Removed`.
	 */
	Rpc.make("index.sync", {
		payload: { after: Schema.Int },
		success: IndexItem,
		stream: true,
	}),
	Rpc.make("auth.save", {
		payload: { credentials: OAuthCredentials },
		success: OAuthInfo,
		error: OAuthError,
	}),
	Rpc.make("auth.status", {
		payload: { provider: OAuthProvider },
		success: Schema.NullOr(OAuthInfo),
		error: OAuthError,
	}),
	Rpc.make("auth.refresh", {
		payload: { provider: OAuthProvider },
		success: Schema.NullOr(OAuthInfo),
		error: OAuthError,
	}),
	Rpc.make("auth.logout", {
		payload: { provider: OAuthProvider },
		success: Schema.Void,
		error: OAuthError,
	}),
	/** A session and its `main` thread; the main thread's info, with the session embedded. */
	Rpc.make("session.create", {
		payload: {
			/** The main thread's title; absent = its first prompt names it. */
			title: optional(Schema.String),
			directory: optional(Schema.String),
			/**
			 * The host directory this session is anchored to, usually the caller's project root.
			 * Unrelated to `directory`, which names a place inside the session's space.
			 *
			 * It is an anchor and nothing more: whatever needs a host-side directory resolves from
			 * here rather than from wherever the server happens to be running. What reads it is the
			 * reader's business, not this field's.
			 *
			 * Optional and honoured as given. Omitting it is normal, not a failure.
			 */
			hostDir: optional(Session.AbsolutePath),
			sandbox: optional(SandboxRef),
			runtime: optional(RuntimeConfig),
			/**
			 * Names the project when this session creates it, ahead of the repository's and the
			 * folder's name. A project that already exists keeps its name; `project.rename` changes it.
			 */
			project: optional(Schema.Struct({ name: ProjectName })),
		},
		success: ThreadInfo,
		/** `HostError` when `hostDir` is a clone still running, failed or cancelled. */
		error: Schema.Union([SessionErrors, SandboxErrors, LocationErrors, HostError]),
	}),
	/** The `origin` URL of a project's main checkout on the host, credentials taken out; null when there is none. */
	Rpc.make("project.remote", {
		payload: { projectId: Schema.String },
		success: Schema.Struct({ url: Schema.NullOr(Schema.String) }),
		error: Project.ProjectNotFoundError,
	}),
	/**
	 * The skills sessions in a space see from its folder. A sandbox is read only while it is running:
	 * otherwise `skills` is null and `sandbox.status` says why. `sandbox` is null for the host.
	 */
	Rpc.make("skill.list", {
		payload: { spaceId: Schema.String },
		success: Schema.Struct({
			sandbox: Schema.NullOr(
				Schema.Struct({
					driver: Schema.String,
					providerResourceId: Schema.NullOr(Schema.String),
					status: Sandbox.SandboxInstance.Status,
				}),
			),
			skills: Schema.NullOr(
				Schema.Array(
					Schema.Struct({
						name: Schema.String,
						description: Schema.String,
						path: Schema.String,
						/** Its frontmatter keeps it out of the prompt. */
						hidden: Schema.Boolean,
					}),
				),
			),
		}),
		error: Schema.Union([Skill.SpaceNotFoundError, SandboxErrors]),
	}),
	Rpc.make("project.rename", {
		payload: { projectId: Schema.String, name: ProjectName },
		success: Schema.Struct({ id: Schema.String, name: Schema.String }),
		error: Project.ProjectNotFoundError,
	}),
	/**
	 * A settings file as written: the project's when `projectId` is given -- the one sessions in its
	 * main checkout read -- otherwise the user's. `version` is what `settings.write` is held to;
	 * `error` is what the runtime would reject in the file as it stands.
	 */
	Rpc.make("settings.read", {
		payload: SettingsFileRef,
		success: Schema.Struct({
			path: Schema.String,
			source: Schema.String,
			exists: Schema.Boolean,
			version: Schema.String,
			/** The file's JSONC as a value; absent when it does not parse. */
			value: optional(Schema.Unknown),
			error: optional(Schema.String),
			/**
			 * For `settings.jsonc`: what applies where this file sets nothing -- the user's settings over the
			 * defaults for a project's file, the defaults for the user's. Absent when a lower file is broken.
			 */
			inherited: optional(Inherited),
			/**
			 * For `mcp.json`: the servers as sessions use them, user and project merged; entries the runtime
			 * skips are left out. `from` is the file that defines the server, not one that only overrides it.
			 */
			servers: optional(
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
		error: Schema.Union([SettingsFileErrors, SettingsFile.SettingsConflictError]),
	}),
	/**
	 * One value at `at` set in place, keeping the rest of the file as written; no `value` removes it.
	 * Refused when the result would not be accepted.
	 */
	Rpc.make("settings.set", {
		payload: {
			...SettingsFileRef,
			at: Schema.NonEmptyArray(Schema.Union([Schema.String, Schema.Int])),
			value: optional(Schema.Unknown),
		},
		success: Schema.Struct({ version: Schema.String }),
		error: SettingsFileErrors,
	}),
	/**
	 * The models a session anchored at `hostDir` can use: providers this server holds credentials
	 * for, in the catalog plus that project's settings, and the model a session runs when it names
	 * none: the one settings name, else one picked from those providers. `default` is absent when
	 * neither gives one. Without `hostDir`, only the user's settings apply. Credentials are checked
	 * for presence, not validity.
	 */
	Rpc.make("model.list", {
		payload: { hostDir: optional(Session.AbsolutePath) },
		success: Schema.Struct({
			providers: Schema.Array(ModelProvider),
			default: optional(
				Schema.Struct({
					provider: Schema.String,
					id: Schema.String,
					/** As settings name it; a run clamps it to what the model supports. */
					thinkingLevel: Schema.Enum(Model.ThinkingLevelEnum),
					/** Display names from the catalog, present even when its provider is not listed. */
					name: optional(Schema.String),
					providerName: optional(Schema.String),
				}),
			),
		}),
		error: Schema.Union([Settings.SettingsError, Runner.ModelCatalogError]),
	}),
	/**
	 * Point an existing session at a host directory, or clear it with `null`.
	 *
	 * Not `session.relink`: that moves where the *work* happens, this changes which host directory
	 * the session is *anchored to*. Conflating them would recreate exactly the `cwd`/`hostDir`
	 * confusion the split exists to remove, which is why they sound alike and stay apart.
	 */
	Rpc.make("session.link", {
		payload: {
			sessionId: Session.SessionSchema.ID,
			/** Absent clears the anchor, leaving the session with no host directory. */
			hostDir: optional(Session.AbsolutePath),
		},
		success: SessionInfo,
		error: SessionStore.SessionNotFoundError,
	}),
	/**
	 * Moves where the work happens. Without `threadId`, the session's default space and directory,
	 * which every thread without its own placement follows; with it, that thread's placement only.
	 * Answers with the addressed thread (`main` when absent): its `placement` and embedded session
	 * show where it now runs.
	 */
	Rpc.make("session.relink", {
		payload: {
			sessionId: Session.SessionSchema.ID,
			threadId: optional(ThreadSchema.ID),
			sandbox: optional(SandboxRef),
			directory: optional(Schema.String),
		},
		success: ThreadInfo,
		error: Schema.Union([SessionErrors, SandboxErrors, LocationErrors]),
	}),
	/** Stops every thread, then removes the session with its log. `deleted` is false when it did not exist. */
	Rpc.make("session.delete", {
		payload: { sessionId: Session.SessionSchema.ID },
		success: Schema.Struct({ deleted: Schema.Boolean }),
	}),
	/** Interrupts every running thread of the session. */
	Rpc.make("session.interrupt", {
		payload: { sessionId: Session.SessionSchema.ID },
		success: Schema.Struct({ interrupted: Schema.Boolean }),
	}),
	/**
	 * A session's durable events after `after` (exclusive; omitted reads from the start), then a
	 * `log.synced` marker at the head read when the call began. With `follow`, each event then
	 * streams as it commits; without it the stream ends at the marker. Every thread of the session
	 * writes this one log; events name their `threadId`.
	 * Ephemeral events (text and tool progress deltas) are never stored, so they are not here;
	 * `event.subscribe` carries them live. To resume, pass the higher of the last event's
	 * `durable.seq` and the last marker's `seq`: the marker can sit past the last event sent.
	 * With `threadId`, only that thread's events; the marker still names the session's head. A fork's
	 * own log starts at its `session.thread.forked`: what it inherits is in `thread.history`.
	 */
	Rpc.make("session.log", {
		payload: {
			sessionId: Session.SessionSchema.ID,
			threadId: optional(ThreadSchema.ID),
			after: optional(Schema.Int),
			follow: optional(Schema.Boolean),
		},
		success: Schema.Union([EventEnvelope, LogSynced]),
		error: Schema.Union([SessionStore.SessionNotFoundError, EncodingError]),
		stream: true,
	}),
	/** Threads newest first, each with its session embedded: of one session, or all. */
	Rpc.make("thread.list", {
		payload: { sessionId: optional(Session.SessionSchema.ID) },
		success: Schema.Array(ThreadInfo),
	}),
	Rpc.make("thread.info", {
		payload: ThreadRef,
		success: ThreadInfo,
		error: ThreadErrors,
	}),
	/**
	 * The conversation in a thread's line: user and assistant messages, inherited ones first, oldest
	 * first. The harness's own entries (compactions, resets, notices) are left out.
	 */
	Rpc.make("thread.history", {
		payload: ThreadRef,
		success: Schema.Struct({ entries: Schema.Array(HistoryEntry) }),
		error: ThreadErrors,
	}),
	/**
	 * Prompts admitted to the thread but not yet promoted, in admission order. Admission and
	 * promotion are durable events, so a client following `session.log` rereads this whenever the
	 * log moves.
	 */
	Rpc.make("thread.queue", {
		payload: ThreadRef,
		success: Schema.Struct({ entries: Schema.Array(QueuedPrompt) }),
		error: ThreadErrors,
	}),
	/**
	 * One thread's detail. Without `after`, the newest entries of its line (inherited ones
	 * included) within `budget` bytes (default 1 MiB) and its pending inbox, then `Synced` with
	 * `floor`. With `after`, its own entries and inbox rows whose revision is past it, then
	 * `Synced`. Then the same live after each commit, with the thread's text and thinking deltas
	 * as `Delta` between.
	 */
	Rpc.make("thread.sync", {
		payload: {
			sessionId: Session.SessionSchema.ID,
			threadId: ThreadSchema.ID,
			after: optional(Schema.Int),
			budget: optional(Schema.Int),
		},
		success: ThreadItem,
		error: Schema.Union([ThreadErrors, Event.SubscriptionOverflowError, EncodingError]),
		stream: true,
	}),
	/**
	 * Older entries of a thread's line (inherited ones included), oldest first: the newest `limit`
	 * whose `seq` is below `before`, cut to `budget` bytes (default 1 MiB). The newest is always sent.
	 */
	Rpc.make("thread.page", {
		payload: {
			sessionId: Session.SessionSchema.ID,
			threadId: ThreadSchema.ID,
			before: Schema.Int,
			limit: Schema.Int,
			budget: optional(Schema.Int),
		},
		success: Schema.Struct({ entries: Schema.Array(HistoryEntry) }),
		error: ThreadErrors,
	}),
	Rpc.make("thread.configure", {
		payload: { ...ThreadRef, runtime: RuntimeConfig },
		success: ThreadInfo,
		error: ThreadErrors,
	}),
	/**
	 * A new thread whose history continues from this one's line through `entryId`, which must be
	 * committed. `before` stops at the entry's predecessor and returns its text to edit again.
	 */
	Rpc.make("thread.fork", {
		payload: { ...ThreadRef, entryId: Schema.String, mode: optional(Schema.Literals(["at", "before"])) },
		success: Schema.Struct({ thread: ThreadInfo, text: optional(Schema.String) }),
		error: Schema.Union([ThreadErrors, ThreadStore.ForkError]),
	}),
	Rpc.make("thread.prompt", {
		payload: {
			...ThreadRef,
			text: Schema.String,
			delivery: optional(PromptSchema.Delivery),
			id: optional(Session.SessionMessageSchema.ID),
		},
		success: Schema.Struct({ threadId: ThreadSchema.ID }),
		error: Schema.Union([ThreadErrors, Control.PromptConflictError]),
	}),
	/**
	 * Withdraws a queued prompt before it joins the conversation. `cancelled` is false when it had
	 * already been promoted (it then stays in the conversation) or no pending prompt has that id.
	 */
	Rpc.make("thread.cancel", {
		payload: { ...ThreadRef, messageId: Session.SessionMessageSchema.ID },
		success: Schema.Struct({ cancelled: Schema.Boolean }),
		error: ThreadErrors,
	}),
	/**
	 * Moves a queued prompt to the other lane or rewrites it, keeping its place in the queue.
	 * `delivery: "steer"` also wakes the thread, so a prompt left waiting after a stop runs now.
	 * `updated` is false when it had already been promoted or cancelled, or no pending prompt has that id.
	 */
	Rpc.make("thread.update", {
		payload: {
			...ThreadRef,
			messageId: Session.SessionMessageSchema.ID,
			delivery: optional(PromptSchema.Delivery),
			text: optional(Schema.String),
		},
		success: Schema.Struct({ updated: Schema.Boolean }),
		error: ThreadErrors,
	}),
	Rpc.make("thread.interrupt", {
		payload: ThreadRef,
		success: Schema.Struct({ interrupted: Schema.Boolean }),
		error: ThreadErrors,
	}),
	/**
	 * Whether a prompt materialized into the thread's conversation. An admitted prompt that is still
	 * queued has no entry yet, so this is the projection a client reconciles against when the
	 * volatile stream left it unsure.
	 */
	Rpc.make("thread.message", {
		payload: { ...ThreadRef, messageId: Session.SessionMessageSchema.ID },
		success: Schema.Struct({ found: Schema.Boolean }),
		error: ThreadErrors,
	}),
	Rpc.make("thread.wait", {
		payload: ThreadRef,
		success: Schema.Void,
		error: ThreadErrors,
	}),
	/**
	 * Re-import every configured plugin, for the whole server.
	 *
	 * The one thing an exchange cannot notice on its own: a local plugin whose contents changed
	 * while its path did not. A failure keeps the previous set and is reported here rather than
	 * emptying a running server's tool registry.
	 */
	Rpc.make("plugin.reload", {
		payload: {},
		// No error channel: a reload that fails keeps the previous set and reports why, because a
		// server that empties its tool registry over a typo is worse than one that says so.
		success: Schema.Struct({ plugins: Schema.Int, failure: optional(Schema.String) }),
	}),
	/**
	 * Close the instance behind a thread's MCP server, or its attempt, and connect it afresh, for
	 * every thread sharing it. Answers once that attempt finished, with the server's state then.
	 */
	Rpc.make("mcp.connect", {
		payload: McpServerRef,
		success: McpStatus,
		error: McpErrors,
	}),
	/** Close it, for every thread sharing it, and keep it closed until `mcp.connect` or a config change. */
	Rpc.make("mcp.disconnect", {
		payload: McpServerRef,
		success: McpStatus,
		error: McpErrors,
	}),
	/** The OS home directory, and the folder `host.create` makes projects in. */
	Rpc.make("host.info", {
		payload: {},
		success: Schema.Struct({ home: Schema.String, projects: Schema.String }),
	}),
	/**
	 * The directories in `path` (a leading `~` is the OS home), hidden ones included, symlinks and
	 * files left out. One the server may not read lists as empty.
	 */
	Rpc.make("host.browse", {
		payload: { path: Schema.String },
		success: Schema.Struct({ path: Schema.String, entries: Schema.Array(Folder) }),
		error: HostError,
	}),
	/**
	 * A new folder under `host.info`'s `projects`, named after `name`, with a git repository and a
	 * README. A first commit git refused is not fatal: `commitError` says why it was skipped.
	 */
	Rpc.make("host.create", {
		payload: { name: Schema.String },
		success: Schema.Struct({ path: Schema.String, commitError: optional(Schema.String) }),
		error: HostError,
	}),
	/** An existing folder as an absolute path; a missing one is created. */
	Rpc.make("host.add", {
		payload: { path: Schema.String },
		success: Schema.Struct({ path: Schema.String }),
		error: HostError,
	}),
	/**
	 * Starts a background clone of `remote` into `path`, which must be missing or empty, and answers
	 * at once with the destination and the redacted remote; `host.clones` follows it. Git never prompts.
	 */
	Rpc.make("host.clone", {
		payload: { remote: Schema.String, path: Schema.String },
		success: Schema.Struct({ path: Schema.String, remote: Schema.String }),
		error: HostError,
	}),
	/** Every tracked clone now, then the whole list again on each change. A finished one leaves 30 seconds after. */
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
		success: Schema.Struct({ ready: Schema.Boolean, hint: optional(Schema.String) }),
	}),
	/** A repository by `owner/name`, `host/owner/name`, its URL, or a bare name of the signed-in user's. */
	Rpc.make("github.lookup", {
		payload: { repository: Schema.String },
		success: Repository,
		error: HostError,
	}),
	Rpc.make("sandbox.drivers", {
		payload: {},
		success: Schema.Array(Schema.Struct({ name: Schema.String, kind: Schema.String })),
	}),
	Rpc.make("sandbox.list", {
		payload: {},
		success: Schema.Array(SandboxInfo),
	}),
	Rpc.make("sandbox.create", {
		payload: { driver: Schema.String },
		success: SandboxInfo,
		error: SandboxErrors,
	}),
	Rpc.make("sandbox.register", {
		payload: { driver: Schema.String, providerResourceId: Schema.String },
		success: SandboxInfo,
		error: SandboxErrors,
	}),
	Rpc.make("sandbox.stop", {
		payload: { sandboxId: Sandbox.SandboxInstance.ID },
		success: Schema.Void,
		error: SandboxErrors,
	}),
	/**
	 * Every event the server publishes, live, after a `server.connected` frame. With `threadId`,
	 * only the events naming that thread; the frame still comes first.
	 */
	Rpc.make("event.subscribe", {
		payload: { threadId: optional(ThreadSchema.ID) },
		success: EventEnvelope,
		error: Schema.Union([Event.SubscriptionOverflowError, EncodingError]),
		stream: true,
	}),
);
