import { Model } from "@codeworksh/aikit";
import {
	Control,
	Event,
	Location,
	optional,
	PromptSchema,
	Sandbox,
	SandboxError,
	Session,
	SessionStore,
} from "@codeworksh/harness/effect";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { EncodingError, EventEnvelope } from "./envelope.ts";

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

export const SessionInfo = Schema.Struct({
	id: Session.SessionSchema.ID,
	title: Schema.String,
	directory: Session.AbsolutePath,
	/** The host directory anchor this session belongs to. Typically this is where your configuration belongs to and read. Absent when it has none. */
	hostDir: optional(Session.AbsolutePath),
	sandbox: optional(SandboxInfo),
});
export type SessionInfo = typeof SessionInfo.Type;

export const RuntimeConfig = Schema.Struct({
	model: optional(Schema.Struct({ provider: Schema.String, id: Schema.String })),
	thinkingLevel: optional(Schema.Enum(Model.ThinkingLevelEnum)),
});
export type RuntimeConfig = typeof RuntimeConfig.Type;

export const SandboxRef = Sandbox.Selection;

const SessionErrors = Schema.Union([
	SessionStore.SessionNotFoundError,
	SessionStore.SessionLinkedSpaceNotFoundError,
	SessionStore.RelinkError,
]);

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

export const Api = RpcGroup.make(
	Rpc.make("session.create", {
		payload: {
			title: optional(Schema.String),
			directory: optional(Schema.String),
			/**
			 * The host directory anchor this session belongs to. Also which this session's settings and project
			 * plugins are read from. Unrelated to `directory`, which names a place inside the session's space.
			 *
			 * Optional and honoured as given. Omitting it is normal, not a failure.
			 */
			hostDir: optional(Session.AbsolutePath),
			sandbox: optional(SandboxRef),
			runtime: optional(RuntimeConfig),
		},
		success: SessionInfo,
		error: Schema.Union([SessionErrors, SandboxErrors, LocationErrors]),
	}),
	Rpc.make("session.list", {
		payload: {},
		success: Schema.Array(SessionInfo),
	}),
	Rpc.make("session.configure", {
		payload: { sessionId: Session.SessionSchema.ID, runtime: RuntimeConfig },
		success: SessionInfo,
		error: SessionStore.SessionNotFoundError,
	}),
	Rpc.make("session.info", {
		payload: { sessionId: Session.SessionSchema.ID },
		success: SessionInfo,
		error: SessionStore.SessionNotFoundError,
	}),
	/**
	 * Point an existing session at a host directory, or clear it with `null`.
	 *
	 * Not `session.relink`: that moves where the *work* happens, this changes where *settings* are
	 * discovered. Conflating them would recreate exactly the `cwd`/`hostDir` confusion the split
	 * exists to remove, which is why they sound alike and stay apart.
	 */
	Rpc.make("session.link", {
		payload: {
			sessionId: Session.SessionSchema.ID,
			/** Absent unlinks, returning the session to the user layer alone. */
			hostDir: optional(Session.AbsolutePath),
		},
		success: SessionInfo,
		error: SessionStore.SessionNotFoundError,
	}),
	Rpc.make("session.relink", {
		payload: {
			sessionId: Session.SessionSchema.ID,
			sandbox: optional(SandboxRef),
			directory: optional(Schema.String),
		},
		success: SessionInfo,
		error: Schema.Union([SessionErrors, SandboxErrors, LocationErrors]),
	}),
	Rpc.make("session.prompt", {
		payload: {
			sessionId: Session.SessionSchema.ID,
			text: Schema.String,
			delivery: optional(PromptSchema.Delivery),
			id: optional(Session.SessionMessageSchema.ID),
		},
		success: Schema.Void,
		error: Schema.Union([SessionStore.SessionNotFoundError, Control.PromptConflictError]),
	}),
	Rpc.make("session.interrupt", {
		payload: { sessionId: Session.SessionSchema.ID },
		success: Schema.Struct({ interrupted: Schema.Boolean }),
	}),
	/**
	 * Whether a prompt materialized into the conversation. An admitted prompt
	 * that is still queued has no entry yet, so this is the projection a client
	 * reconciles against when the volatile stream left it unsure
	 */
	Rpc.make("session.message", {
		payload: { sessionId: Session.SessionSchema.ID, messageId: Session.SessionMessageSchema.ID },
		success: Schema.Struct({ found: Schema.Boolean }),
	}),
	Rpc.make("session.wait", {
		payload: { sessionId: Session.SessionSchema.ID },
		success: Schema.Void,
		error: SessionStore.SessionNotFoundError,
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
	Rpc.make("event.subscribe", {
		payload: {},
		success: EventEnvelope,
		error: Schema.Union([Event.SubscriptionOverflowError, EncodingError]),
		stream: true,
	}),
);

export * as Contract from "./contract.ts";
