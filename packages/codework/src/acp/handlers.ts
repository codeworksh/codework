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
import { methods, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import { type Model } from "@codeworksh/aikit";
import {
	Control,
	Event,
	EventList,
	type Location,
	ModelCatalog,
	PromptSchema,
	type SandboxError,
	Session,
	SessionStore,
	Settings,
} from "@codeworksh/harness/effect";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { parseModelValue, resolveConfigOptions } from "./config.ts";
import { entryToSessionUpdates, toSessionUpdate } from "./feed.ts";

export type SessionCreateError =
	| Location.Error
	| SandboxError.SandboxMountError
	| SessionStore.SessionNotFoundError
	| SessionStore.SessionLinkedSpaceNotFoundError
	| RequestError;

export interface Interface {
	readonly initialize: (params: InitializeRequest) => Effect.Effect<InitializeResponse>;
	readonly newSession: (params: NewSessionRequest) => Effect.Effect<NewSessionResponse, SessionCreateError>;
	readonly loadSession: (
		params: LoadSessionRequest,
		client?: AgentContext,
	) => Effect.Effect<LoadSessionResponse, SessionStore.SessionNotFoundError | RequestError>;
	readonly setConfigOption: (
		params: SetSessionConfigOptionRequest,
	) => Effect.Effect<SetSessionConfigOptionResponse, SessionStore.SessionNotFoundError | RequestError>;
	readonly listSessions: (params: ListSessionsRequest) => Effect.Effect<ListSessionsResponse>;
	readonly prompt: (
		params: PromptRequest,
		client?: AgentContext,
	) => Effect.Effect<PromptResponse, SessionStore.SessionNotFoundError | Control.PromptConflictError | RequestError>;
	readonly cancel: (params: CancelNotification) => Effect.Effect<{ readonly cancelled: boolean }>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/cli/acp/handlers/Service") {}

export const extractPromptText = (blocks: ReadonlyArray<ContentBlock>): string =>
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
				const label = block.name ? `${block.name} (${block.uri})` : block.uri;
				const mime = block.mimeType ? ` [${block.mimeType}]` : "";
				return `[Resource: ${label}${mime}]`;
			}
			if (block.type === "image" || block.type === "audio") {
				return `[Attached ${block.type}: not currently supported]`;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n\n");

const isInterruptedEvent = Schema.is(EventList.ExecutionInterrupted);
const isFailedEvent = Schema.is(EventList.ExecutionFailed);
const isLLMEndedEvent = Schema.is(EventList.LLMEnded);

type ExecutionError = EventList.ExecutionFailed["data"]["error"];

const validThinkingLevels: ReadonlyArray<string> = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const control = yield* Control.Service;
		const sessions = yield* SessionStore.Service;
		const events = yield* Event.Service;
		const settings = yield* Settings.Service;

		const env = yield* Effect.context<
			| Control.Service
			| SessionStore.Service
			| Event.Service
			| Settings.Service
			| Effect.Services<ReturnType<typeof Session.create>>
			| Effect.Services<ReturnType<typeof Session.attach>>
		>();

		interface SessionConfigState {
			provider?: string;
			model?: string;
			thinkingLevel?: Model.ThinkingLevel;
		}

		const sessionConfigs = new Map<string, SessionConfigState>();
		const cancelledSessions = new Set<string>();
		const activePrompts = new Set<string>();

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
				const handle = yield* Session.create({
					...(cwd === undefined ? {} : { directory: cwd, hostDir: cwd }),
					title: "ACP Session",
				}).pipe(Effect.provide(env));

				const loaded = yield* settings.load(cwd).pipe(
					Effect.provide(env),
					Effect.orElseSucceed(() => undefined),
				);

				if (loaded?.model) {
					sessionConfigs.set(handle.id, {
						provider: loaded.model.provider,
						model: loaded.model.id,
						thinkingLevel: loaded.model.thinkingLevel,
					});
				}

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
				if (Option.isNone(session)) {
					return yield* new SessionStore.SessionNotFoundError({ sessionId: sid });
				}

				const hostDir = Option.getOrUndefined(session.value.hostDir);
				const loaded = yield* settings.load(hostDir).pipe(
					Effect.provide(env),
					Effect.orElseSucceed(() => undefined),
				);

				const sessionOptions = sessionConfigs.get(sid);
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

				const existing = sessionConfigs.get(sid) ?? {};

				if (configId === "thought_level") {
					if (typeof value !== "string" || !validThinkingLevels.includes(value)) {
						const msg = `Invalid thinking level: ${String(value)}`;
						return yield* Effect.fail(RequestError.invalidParams(msg, msg));
					}
					const thinkingLevel = value as Model.ThinkingLevel;
					existing.thinkingLevel = thinkingLevel;
					yield* Session.attach({ sessionId: sid, thinkingLevel }).pipe(Effect.provide(env));
				} else if (configId === "model") {
					if (typeof value !== "string") {
						const msg = `Invalid model value: ${String(value)}`;
						return yield* Effect.fail(RequestError.invalidParams(msg, msg));
					}
					const parsed = parseModelValue(value);
					const catalog = yield* ModelCatalog.models.pipe(Effect.orElseSucceed(() => undefined));
					if (catalog && !catalog[parsed.provider]?.[parsed.modelId]) {
						const msg = `Unknown model: ${value}`;
						return yield* Effect.fail(RequestError.invalidParams(msg, msg));
					}

					existing.provider = parsed.provider;
					existing.model = parsed.modelId;
					yield* Session.attach({
						sessionId: sid,
						model: { provider: parsed.provider, id: parsed.modelId },
					}).pipe(Effect.provide(env));
				} else {
					const msg = `Unknown config option: ${configId}`;
					return yield* Effect.fail(RequestError.invalidParams(msg, msg));
				}

				sessionConfigs.set(sid, existing);

				const hostDir = Option.getOrUndefined(found.value.hostDir);
				const loaded = yield* settings.load(hostDir).pipe(
					Effect.provide(env),
					Effect.orElseSucceed(() => undefined),
				);

				const configOptions = yield* resolveConfigOptions({
					provider: existing.provider ?? loaded?.model.provider,
					model: existing.model ?? loaded?.model.id,
					thinkingLevel: existing.thinkingLevel ?? loaded?.model.thinkingLevel,
				});

				return { configOptions };
			}),
			listSessions: Effect.fnUntraced(function* ({ cwd, cursor }) {
				const rows = yield* sessions.list().pipe(Effect.provide(env));
				const sorted = [...rows].sort((a, b) => {
					const timeA = DateTime.toEpochMillis(a.updatedAt ?? a.createdAt);
					const timeB = DateTime.toEpochMillis(b.updatedAt ?? b.createdAt);
					return timeB - timeA;
				});

				const filtered =
					cwd === undefined || cwd === null
						? sorted
						: sorted.filter((row) => {
								const host = Option.getOrUndefined(row.hostDir);
								if (!host) return false;
								return host === cwd || host.startsWith(cwd.endsWith("/") ? cwd : `${cwd}/`);
							});

				const offset = cursor ? Number.parseInt(cursor, 10) : 0;
				const limit = 50;
				const page = filtered.slice(offset, offset + limit);
				const nextCursor = offset + limit < filtered.length ? String(offset + limit) : undefined;

				return {
					sessions: page.map((row) => {
						const host = Option.getOrUndefined(row.hostDir);
						return {
							sessionId: row.id,
							cwd: host ?? row.directory,
							title: row.title,
							updatedAt: row.updatedAt ? DateTime.formatIso(row.updatedAt) : null,
						};
					}),
					...(nextCursor !== undefined ? { nextCursor } : {}),
				};
			}),
			prompt: Effect.fnUntraced(function* ({ sessionId, prompt }, client) {
				const sid = Session.SessionSchema.ID.make(sessionId);
				const found = yield* Session.get(sid).pipe(Effect.provide(env));
				if (Option.isNone(found)) {
					return yield* new SessionStore.SessionNotFoundError({ sessionId: sid });
				}

				if (activePrompts.has(sessionId)) {
					const msg = "A prompt is already in progress for this session";
					return yield* Effect.fail(RequestError.invalidParams(msg, msg));
				}

				const text = extractPromptText(prompt);

				const turnOutcome: {
					interrupted: boolean;
					terminalFailure?: ExecutionError;
					lastLLMReason?: "stop" | "length" | "toolUse";
				} = {
					interrupted: cancelledSessions.delete(sessionId),
				};

				const unsubscribe = yield* events.listen((event) => {
					if (isInterruptedEvent(event) && event.data.sessionId === sid) {
						turnOutcome.interrupted = true;
					}
					if (isFailedEvent(event) && event.data.sessionId === sid) {
						turnOutcome.terminalFailure = event.data.error;
					}
					if (isLLMEndedEvent(event) && event.data.sessionId === sid) {
						turnOutcome.lastLLMReason = event.data.reason;
					}

					if (client !== undefined) {
						const item = toSessionUpdate(event);
						if (item && item.sessionId === sid) {
							return Effect.promise(() => client.notify(methods.client.session.update, item)).pipe(
								Effect.ignore,
							);
						}
					}
					return Effect.void;
				});

				activePrompts.add(sessionId);
				try {
					yield* control.run({
						sessionId: sid,
						prompt: PromptSchema.Prompt.make({ text }),
					}).pipe(Effect.provide(env));
				} finally {
					activePrompts.delete(sessionId);
					yield* unsubscribe;
				}

				if (turnOutcome.interrupted) {
					return { stopReason: "cancelled" as const };
				}
				if (turnOutcome.terminalFailure !== undefined) {
					return yield* Effect.fail(
						RequestError.internalError(turnOutcome.terminalFailure.message, turnOutcome.terminalFailure.message),
					);
				}
				if (turnOutcome.lastLLMReason === "length") {
					return { stopReason: "max_tokens" as const };
				}
				return { stopReason: "end_turn" as const };
			}),
			cancel: Effect.fnUntraced(function* ({ sessionId }) {
				const sid = Session.SessionSchema.ID.make(sessionId);
				cancelledSessions.add(sessionId);
				const interrupted = yield* control.interrupt(sid, { reason: "user" }).pipe(Effect.provide(env));
				return { cancelled: interrupted };
			}),
		});
	}),
);

export * as Handlers from "./handlers.ts";
