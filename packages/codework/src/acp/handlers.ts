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
	SetSessionConfigOptionRequest,
	SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { Model } from "@codeworksh/aikit";
import {
	Control,
	Event,
	Location,
	PromptSchema,
	SandboxError,
	Session,
	SessionStore,
	Settings,
} from "@codeworksh/harness/effect";
import { Cause, Context, DateTime, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import * as SandboxController from "../../../harness/src/sandbox/control.ts";
import * as SessionRuntime from "../../../harness/src/session/runtime.ts";
import { resolveConfigOptions } from "./config.ts";
import { entryToSessionUpdates, toSessionUpdate } from "./feed.ts";

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
		client?: AgentContext,
	) => Effect.Effect<LoadSessionResponse, SessionStore.SessionNotFoundError>;
	readonly setConfigOption: (
		params: SetSessionConfigOptionRequest,
	) => Effect.Effect<SetSessionConfigOptionResponse, SessionStore.SessionNotFoundError>;
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
		const runtime = yield* SessionRuntime.Service;
		yield* SandboxController.Controller;
		const events = yield* Event.Service;
		yield* SqlClient.SqlClient;
		const settings = yield* Settings.Service;

		const env = yield* Effect.context<
			| Control.Service
			| SessionStore.Service
			| SessionRuntime.Service
			| SandboxController.Controller
			| Event.Service
			| SqlClient.SqlClient
			| Settings.Service
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
				const loaded = yield* settings.load(cwd).pipe(
					Effect.provide(env),
					Effect.orElseSucceed(() => undefined),
				);
				const configOptions = yield* resolveConfigOptions({
					provider: loaded?.model.provider,
					model: loaded?.model.id,
					thinkingLevel: loaded?.model.thinkingLevel,
				});
				return {
					sessionId: handle.id,
					...(configOptions.length > 0 ? { configOptions } : {}),
				};
			}),
			loadSession: Effect.fnUntraced(function* ({ sessionId }, client?: AgentContext) {
				const sid = Session.SessionSchema.ID.make(sessionId);
				yield* Session.attach({ sessionId: sid }).pipe(Effect.provide(env));
				const session = yield* sessions.get(sid).pipe(Effect.provide(env));
				const hostDir = Option.isNone(session) ? undefined : Option.getOrUndefined(session.value.hostDir);
				const loaded = yield* settings.load(hostDir).pipe(
					Effect.provide(env),
					Effect.orElseSucceed(() => undefined),
				);
				const sessionOptions = Option.getOrUndefined(yield* runtime.get(sid).pipe(Effect.provide(env)));
				const configOptions = yield* resolveConfigOptions({
					provider: sessionOptions?.provider ?? loaded?.model.provider,
					model: sessionOptions?.model ?? loaded?.model.id,
					thinkingLevel: sessionOptions?.thinkingLevel ?? loaded?.model.thinkingLevel,
				});

				if (client) {
					const pathEntries = yield* sessions.path(sid).pipe(Effect.provide(env));
					for (const entry of pathEntries) {
						const updates = entryToSessionUpdates(entry);
						for (const update of updates) {
							yield* Effect.promise(() =>
								client.notify(methods.client.session.update, {
									sessionId: sid,
									update,
								}),
							).pipe(Effect.ignore);
						}
					}
				}

				return configOptions.length > 0 ? { configOptions } : {};
			}),
			setConfigOption: Effect.fnUntraced(function* ({ sessionId, configId, value }) {
				const sid = Session.SessionSchema.ID.make(sessionId);
				const found = yield* sessions.get(sid).pipe(Effect.provide(env));
				if (Option.isNone(found)) {
					return yield* new SessionStore.SessionNotFoundError({ sessionId: sid });
				}

				if (configId === "thought_level") {
					if (typeof value === "string") {
						yield* runtime.update(sid, { thinkingLevel: value as Model.ThinkingLevel }).pipe(Effect.provide(env));
					}
				} else if (configId === "model") {
					if (typeof value === "string") {
						const slashIndex = value.indexOf("/");
						const nextProvider = slashIndex !== -1 ? value.slice(0, slashIndex) : undefined;
						const nextModel = slashIndex !== -1 ? value.slice(slashIndex + 1) : value;
						yield* runtime
							.update(sid, {
								...(nextProvider ? { provider: nextProvider } : {}),
								model: nextModel,
							})
							.pipe(Effect.provide(env));
					}
				}

				const hostDir = Option.getOrUndefined(found.value.hostDir);
				const loaded = yield* settings.load(hostDir).pipe(
					Effect.provide(env),
					Effect.orElseSucceed(() => undefined),
				);
				const sessionOptions = Option.getOrUndefined(yield* runtime.get(sid).pipe(Effect.provide(env)));
				const configOptions = yield* resolveConfigOptions({
					provider: sessionOptions?.provider ?? loaded?.model.provider,
					model: sessionOptions?.model ?? loaded?.model.id,
					thinkingLevel: sessionOptions?.thinkingLevel ?? loaded?.model.thinkingLevel,
				});
				return { configOptions };
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
