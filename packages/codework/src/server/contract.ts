import { Model } from "@codeworksh/aikit";
import {
	Control,
	Event,
	EventList,
	Location,
	McpError,
	optional,
	Project,
	PromptSchema,
	Runner,
	Sandbox,
	SandboxError,
	Session,
	SessionStore,
	Settings,
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

/** The container: where its threads run by default, and which host project it reads. */
export const SessionInfo = Schema.Struct({
	id: Session.SessionSchema.ID,
	directory: Session.AbsolutePath,
	/** The host directory this session is anchored to. Absent when it has none. */
	hostDir: optional(Session.AbsolutePath),
	sandbox: optional(SandboxInfo),
	/** The project the session's space belongs to. */
	project: optional(Schema.Struct({ id: Schema.String, name: Schema.String })),
	/** Last activity in any of its threads, epoch milliseconds. */
	updatedAt: Schema.Finite,
	/** Where unaddressed prompts go. */
	mainThreadId: ThreadSchema.ID,
});
export type SessionInfo = typeof SessionInfo.Type;

export const ThreadOrigin = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("main") }),
	Schema.Struct({ kind: Schema.Literal("fork"), threadId: Schema.String, entryId: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal("subagent"),
		threadId: Schema.String,
		callId: Schema.String,
		entryId: optional(Schema.String),
	}),
]);

/** Billed usage of a thread's own entries; what it inherits through a fork point counts for its source. */
export const ThreadUsage = Schema.Struct({
	/** Total cost in US dollars, from the catalog's prices. */
	cost: Schema.Finite,
	input: Schema.Int,
	output: Schema.Int,
	cacheRead: Schema.Int,
	cacheWrite: Schema.Int,
});
export type ThreadUsage = typeof ThreadUsage.Type;

/** One linear transcript of a session, with the session embedded. */
export const ThreadInfo = Schema.Struct({
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
	/** Where it runs instead of the session's space and directory. */
	placement: optional(Schema.Struct({ spaceId: Schema.String, directory: Session.AbsolutePath })),
	/** Its unfinished run was cut off by restarts too often to resume on its own; the next prompt runs it. */
	parked: optional(Schema.Boolean),
	usage: ThreadUsage,
	session: SessionInfo,
});
export type ThreadInfo = typeof ThreadInfo.Type;

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
});
export type HistoryEntry = typeof HistoryEntry.Type;

/** A prompt admitted but not yet in the conversation: a steer waiting for the next model request, or a follow-up for the next turn. */
export const QueuedPrompt = Schema.Struct({
	/** The id of the user message it becomes once promoted. */
	id: Schema.String,
	delivery: PromptSchema.Delivery,
	text: Schema.String,
	/** Epoch milliseconds. */
	createdAt: Schema.Finite,
});
export type QueuedPrompt = typeof QueuedPrompt.Type;

/** Ends `session.log`'s replay; `seq` is absent when the session has no durable events yet. */
export const LogSynced = Schema.Struct({
	type: Schema.Literal("log.synced"),
	/** The session the log was read for. */
	aggregateId: Schema.String,
	seq: optional(Schema.Int),
});
export type LogSynced = typeof LogSynced.Type;

/** A thread's model and thinking choices: a given field replaces the stored one, `null` clears it. */
export const RuntimeConfig = Schema.Struct({
	model: optional(Schema.NullOr(Schema.Struct({ provider: Schema.String, id: Schema.String }))),
	thinkingLevel: optional(Schema.NullOr(Schema.Enum(Model.ThinkingLevelEnum))),
});
export type RuntimeConfig = typeof RuntimeConfig.Type;

export const SandboxRef = Sandbox.Selection;

/** A model to choose, by the catalog's id and display name, with the thinking levels it supports. */
export const ModelOption = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	/** In ascending order; `["off"]` for a model that does not reason. */
	thinkingLevels: Schema.Array(Schema.Enum(Model.ThinkingLevelEnum)),
});

/** A provider this server can call, with the models a session may use from it. */
export const ModelProvider = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	models: Schema.Array(ModelOption),
});
export type ModelProvider = typeof ModelProvider.Type;

/** A project's name as a client sets it: trimmed, never empty. */
export const ProjectName = Schema.Trimmed.check(Schema.isNonEmpty());

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
export const McpStatus = Schema.Struct({
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
		success: Schema.Struct({ pid: Schema.Int, version: Schema.String }),
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
		error: Schema.Union([SessionErrors, SandboxErrors, LocationErrors]),
	}),
	Rpc.make("project.rename", {
		payload: { projectId: Schema.String, name: ProjectName },
		success: Schema.Struct({ id: Schema.String, name: Schema.String }),
		error: Project.ProjectNotFoundError,
	}),
	/**
	 * The models a session anchored at `hostDir` can use: providers this server holds credentials
	 * for, in the catalog plus that project's settings, and the model settings pick when a session
	 * names none. Without `hostDir`, only the user's settings apply. Credentials are checked for
	 * presence, not validity.
	 */
	Rpc.make("model.list", {
		payload: { hostDir: optional(Session.AbsolutePath) },
		success: Schema.Struct({
			providers: Schema.Array(ModelProvider),
			default: Schema.Struct({
				provider: Schema.String,
				id: Schema.String,
				/** As settings name it; a run clamps it to what the model supports. */
				thinkingLevel: Schema.Enum(Model.ThinkingLevelEnum),
				/** Display names from the catalog, present even when its provider is not listed. */
				name: optional(Schema.String),
				providerName: optional(Schema.String),
			}),
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

export * as Contract from "./contract.ts";
