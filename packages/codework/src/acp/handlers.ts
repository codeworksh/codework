import type {
	AgentContext,
	CancelNotification,
	ContentBlock,
	InitializeRequest,
	InitializeResponse,
	ListSessionsRequest,
	ListSessionsResponse,
	LoadSessionRequest,
	LoadSessionResponse,
	NewSessionRequest,
	NewSessionResponse,
	PromptRequest,
	PromptResponse,
} from "@agentclientprotocol/sdk";
import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import {
	Control,
	Event,
	Location,
	PromptSchema,
	SandboxError,
	Session,
	SessionStore,
} from "@codeworksh/harness/effect";
import { Cause, Context, DateTime, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import * as SandboxController from "../../../harness/src/sandbox/control.ts";
import * as SessionRuntime from "../../../harness/src/session/runtime.ts";
import { toSessionUpdate } from "./feed.ts";

export type SessionCreateError =
	| Location.Error
	| SandboxError.SandboxMountError
	| SessionStore.SessionNotFoundError
	| SessionStore.SessionLinkedSpaceNotFoundError;

export interface Interface {
	readonly initialize: (params: InitializeRequest) => Effect.Effect<InitializeResponse>;
	readonly newSession: (params: NewSessionRequest) => Effect.Effect<NewSessionResponse, SessionCreateError>;
	readonly loadSession: (
		params: LoadSessionRequest,
	) => Effect.Effect<LoadSessionResponse, SessionStore.SessionNotFoundError>;
	readonly listSessions: (params: ListSessionsRequest) => Effect.Effect<ListSessionsResponse>;
	readonly prompt: (
		params: PromptRequest,
		client?: AgentContext,
	) => Effect.Effect<PromptResponse, SessionStore.SessionNotFoundError | Control.PromptConflictError>;
	readonly cancel: (params: CancelNotification) => Effect.Effect<{ readonly cancelled: boolean }>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/cli/acp/handlers/Service") {}

const extractPromptText = (blocks: ReadonlyArray<ContentBlock>): string =>
	blocks
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "resource") {
				const res = block.resource;
				if ("text" in res && typeof res.text === "string") {
					const uri = "uri" in res && typeof res.uri === "string" ? res.uri : "file";
					return `\n\`\`\`${uri}\n${res.text}\n\`\`\`\n`;
				}
				return "";
			}
			if (block.type === "resource_link") {
				return `[Resource: ${block.name ?? block.uri}]`;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n\n");

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const control = yield* Control.Service;
		const sessions = yield* SessionStore.Service;
		yield* SessionRuntime.Service;
		yield* SandboxController.Controller;
		const events = yield* Event.Service;
		yield* SqlClient.SqlClient;

		const env = yield* Effect.context<
			| Control.Service
			| SessionStore.Service
			| SessionRuntime.Service
			| SandboxController.Controller
			| Event.Service
			| SqlClient.SqlClient
		>();

		return Service.of({
			initialize: (_params) =>
				Effect.succeed({
					protocolVersion: PROTOCOL_VERSION,
					agentCapabilities: {
						loadSession: true,
						sessionCapabilities: {
							list: {},
						},
					},
				}),
			newSession: Effect.fnUntraced(function* ({ cwd }) {
				const handle = yield* Session.create(cwd === undefined ? {} : { directory: cwd }).pipe(Effect.provide(env));
				return { sessionId: handle.id };
			}),
			loadSession: Effect.fnUntraced(function* ({ sessionId }) {
				yield* Session.attach({
					sessionId: Session.SessionSchema.ID.make(sessionId),
				}).pipe(Effect.provide(env));
				return {};
			}),
			listSessions: Effect.fnUntraced(function* ({ cwd }) {
				const rows = yield* sessions.list().pipe(Effect.provide(env));
				const filtered =
					cwd === undefined || cwd === null
						? rows
						: rows.filter((row) => row.directory === cwd || row.directory.startsWith(cwd));
				return {
					sessions: filtered.map((row) => ({
						sessionId: row.id,
						cwd: row.directory,
						title: row.title,
						updatedAt: row.updatedAt ? DateTime.formatIso(row.updatedAt) : null,
					})),
				};
			}),
			prompt: Effect.fnUntraced(function* ({ sessionId, prompt }, client) {
				const text = extractPromptText(prompt);
				const sid = Session.SessionSchema.ID.make(sessionId);
				const found = yield* Session.get(sid).pipe(Effect.provide(env));
				if (Option.isNone(found)) {
					return yield* new SessionStore.SessionNotFoundError({ sessionId: sid });
				}

				const unsubscribe =
					client === undefined
						? Effect.void
						: yield* events.listen((event) => {
								const item = toSessionUpdate(event);
								if (item && item.sessionId === sid) {
									return Effect.promise(() => client.notify(methods.client.session.update, item)).pipe(
										Effect.ignore,
									);
								}
								return Effect.void;
							});

				return yield* control
					.run({
						sessionId: sid,
						prompt: PromptSchema.Prompt.make({ text }),
					})
					.pipe(
						Effect.map(() => ({ stopReason: "end_turn" as const })),
						Effect.catchCauseIf(Cause.hasInterrupts, () => Effect.succeed({ stopReason: "cancelled" as const })),
						Effect.ensuring(unsubscribe),
					);
			}),
			cancel: Effect.fnUntraced(function* ({ sessionId }) {
				const interrupted = yield* control.interrupt(Session.SessionSchema.ID.make(sessionId), {
					reason: "user",
				});
				return { cancelled: interrupted };
			}),
		});
	}),
);

export * as Handlers from "./handlers.ts";
