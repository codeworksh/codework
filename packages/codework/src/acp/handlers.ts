import type * as AcpAgent from "@codeworksh/acp/agent";
import { AcpRequestError } from "@codeworksh/acp/errors";
import type * as Acp from "@codeworksh/acp/schema-v1";
import {
	Control,
	EventList,
	type EventSchema,
	type Harness,
	PromptSchema,
	Session,
	SessionStore,
} from "@codeworksh/harness/effect";
import { DateTime, Effect, Fiber, type Layer, Option, Schema, Stream } from "effect";
import pkg from "../../package.json" with { type: "json" };
import { Config } from "./config.ts";
import { Feed } from "./feed.ts";

const PAGE_SIZE = 50;

const isRequestError = Schema.is(AcpRequestError);
const isNotFound = Schema.is(SessionStore.SessionNotFoundError);
const isConflict = Schema.is(Control.PromptConflictError);
const isInvalidPrompt = Schema.is(PromptSchema.InvalidPromptError);
const isLLMEnded = Schema.is(EventList.LLMEnded);
const isSucceeded = Schema.is(EventList.ExecutionSucceeded);
const isFailed = Schema.is(EventList.ExecutionFailed);
const isInterrupted = Schema.is(EventList.ExecutionInterrupted);
const isSettled = (event: EventSchema.Payload) => isSucceeded(event) || isFailed(event) || isInterrupted(event);

/** Harness failures as JSON-RPC errors; handlers raise protocol-level ones directly. */
const toRequestError = (error: { readonly message: string }): AcpRequestError => {
	if (isRequestError(error)) return error;
	if (isNotFound(error)) return AcpRequestError.resourceNotFound(`Session not found: ${error.sessionId}`);
	if (isConflict(error)) return AcpRequestError.invalidRequest(error.message);
	if (isInvalidPrompt(error)) return AcpRequestError.invalidParams(error.message);
	return AcpRequestError.internalError(error.message);
};

/**
 * Prompt content as harness prompt parts, in order. Text, embedded context and images are
 * advertised; anything else is rejected. Adjacent text joins into one part. The harness checks
 * the images.
 */
const promptParts = Effect.fnUntraced(function* (blocks: ReadonlyArray<Acp.ContentBlock>) {
	const parts: Array<PromptSchema.Part> = [];
	const add = (part: PromptSchema.Part) => {
		const last = parts.at(-1);
		if (part.type === "text" && last?.type === "text")
			parts[parts.length - 1] = { ...last, text: `${last.text}\n\n${part.text}` };
		else parts.push(part);
	};
	for (const block of blocks) {
		switch (block.type) {
			case "text":
				add({ type: "text", text: block.text });
				break;
			case "resource_link":
				add({ type: "text", text: `[${block.name}](${block.uri})` });
				break;
			case "image":
				add({ type: "image", data: block.data, mimeType: block.mimeType });
				break;
			case "resource":
				if ("text" in block.resource) {
					add({ type: "text", text: `\`\`\`${block.resource.uri}\n${block.resource.text}\n\`\`\`` });
				} else if (block.resource.mimeType?.startsWith("image/")) {
					add({ type: "image", data: block.resource.blob, mimeType: block.resource.mimeType });
				} else {
					return yield* AcpRequestError.invalidParams(`Unsupported binary resource: ${block.resource.uri}`);
				}
				break;
			default:
				return yield* AcpRequestError.invalidParams(`Unsupported prompt content: ${block.type}`);
		}
	}
	return parts;
});

const sessionId = (id: string) => Session.SessionSchema.ID.make(id);

type Services = Layer.Success<ReturnType<typeof Harness.layer>>;

export const make = Effect.gen(function* () {
	const control = yield* Control.Service;
	const sessions = yield* SessionStore.Service;
	// Handlers run on the agent's fibers, outside this layer; they carry the harness with them.
	const context = yield* Effect.context<Services>();

	const running = new Set<string>();

	const found = Effect.fn("ACP.found")(function* (id: string) {
		const row = yield* sessions.get(sessionId(id));
		if (Option.isNone(row)) return yield* new SessionStore.SessionNotFoundError({ sessionId: sessionId(id) });
		return row.value;
	});

	return (client: AcpAgent.Client): AcpAgent.Handlers => {
		const run = <A, E extends { readonly message: string }>(effect: Effect.Effect<A, E, Services>) =>
			effect.pipe(Effect.provide(context), Effect.mapError(toRequestError));

		return {
			initialize: () =>
				Effect.succeed({
					protocolVersion: 1,
					agentInfo: { name: "codework", version: pkg.version },
					agentCapabilities: {
						loadSession: true,
						promptCapabilities: { embeddedContext: true, image: true },
						sessionCapabilities: { list: {} },
					},
				}),

			newSession: ({ cwd }) =>
				run(
					Effect.gen(function* () {
						const handle = yield* Session.create({ directory: cwd, hostDir: cwd });
						const current = yield* Session.configuration(handle.id);
						return { sessionId: handle.id, configOptions: yield* Config.options(current, cwd) };
					}),
				),

			loadSession: ({ sessionId: id }) =>
				run(
					Effect.gen(function* () {
						yield* Session.attach({ sessionId: sessionId(id) });
						const row = yield* found(id);
						const hostDir = Option.getOrUndefined(row.hostDir);
						const current = yield* Session.configuration(row.id);
						for (const entry of yield* sessions.path(sessionId(id))) {
							for (const update of Feed.replay(entry)) {
								yield* client.sessionUpdate({ sessionId: id, update });
							}
						}
						return { configOptions: yield* Config.options(current, hostDir) };
					}),
				),

			listSessions: ({ cwd, cursor }) =>
				run(
					Effect.gen(function* () {
						const rows = (yield* sessions.list())
							.filter((row) => cwd == null || Option.getOrUndefined(row.hostDir) === cwd)
							.sort((a, b) => DateTime.Order(b.updatedAt ?? b.createdAt, a.updatedAt ?? a.createdAt));
						const offset = cursor == null ? 0 : Number(cursor);
						if (!Number.isSafeInteger(offset) || offset < 0) {
							return yield* AcpRequestError.invalidParams(`Invalid cursor: ${cursor}`);
						}
						const next = offset + PAGE_SIZE;
						return {
							sessions: rows.slice(offset, next).map((row) => ({
								sessionId: row.id,
								cwd: Option.getOrElse(row.hostDir, () => row.directory),
								title: row.title,
								updatedAt: DateTime.formatIso(row.updatedAt ?? row.createdAt),
							})),
							...(next < rows.length ? { nextCursor: String(next) } : {}),
						};
					}),
				),

			setConfigOption: (request) =>
				run(
					Effect.gen(function* () {
						const row = yield* found(request.sessionId);
						const hostDir = Option.getOrUndefined(row.hostDir);
						const value = String(request.value);
						if (request.configId === Config.MODEL) {
							const model = Option.getOrUndefined(Config.parseModel(value));
							if (model === undefined || !(yield* Config.known(model, hostDir))) {
								return yield* AcpRequestError.invalidParams(`Unknown model: ${value}`);
							}
							yield* Session.attach({ sessionId: row.id, model });
						} else if (request.configId === Config.THOUGHT_LEVEL) {
							if (!Config.isThinkingLevel(value)) {
								return yield* AcpRequestError.invalidParams(`Unknown thinking level: ${value}`);
							}
							yield* Session.attach({ sessionId: row.id, thinkingLevel: value });
						} else {
							return yield* AcpRequestError.invalidParams(`Unknown config option: ${request.configId}`);
						}
						return { configOptions: yield* Config.options(yield* Session.configuration(row.id), hostDir) };
					}),
				),

			prompt: ({ sessionId: id, prompt }) =>
				run(
					Effect.gen(function* () {
						const parts = yield* promptParts(prompt);
						const handle = Option.getOrUndefined(yield* Session.get(sessionId(id)));
						if (handle === undefined) {
							return yield* new SessionStore.SessionNotFoundError({ sessionId: sessionId(id) });
						}
						if (running.has(id)) {
							return yield* AcpRequestError.invalidRequest("A prompt is already running for this session");
						}
						running.add(id);
						yield* Effect.addFinalizer(() => Effect.sync(() => running.delete(id)));

						// Forward this execution's updates until it settles; the settling event decides the answer.
						let reason: EventList.LLMEnded["data"]["reason"] | undefined;
						// Plugins are checked every exchange; tell the user about each failure once per prompt.
						const notices = new Set<string>();
						const settled = yield* handle.events().pipe(
							Stream.tap((event) => {
								if (isLLMEnded(event)) reason = event.data.reason;
								let update = Feed.update(event);
								const notice = Feed.notice(event);
								if (Option.isSome(notice) && !notices.has(notice.value)) {
									notices.add(notice.value);
									update = Option.some(Feed.noticeUpdate(notice.value));
								}
								return Option.match(update, {
									onNone: () => Effect.void,
									onSome: (update) => client.sessionUpdate({ sessionId: id, update }).pipe(Effect.ignore),
								});
							}),
							Stream.filter(isSettled),
							Stream.runHead,
							Effect.forkScoped({ startImmediately: true }),
						);
						const before = (yield* handle.info).title;
						yield* handle.run({ parts });
						const end = yield* Fiber.join(settled);

						// The harness titles a session from its first prompt; tell the editor.
						const { title } = yield* handle.info;
						if (title !== before) {
							yield* client
								.sessionUpdate({ sessionId: id, update: { sessionUpdate: "session_info_update", title } })
								.pipe(Effect.ignore);
						}

						if (Option.isNone(end) || isInterrupted(end.value)) return { stopReason: "cancelled" as const };
						if (isFailed(end.value)) return yield* AcpRequestError.internalError(end.value.data.error.message);
						return { stopReason: reason === "length" ? ("max_tokens" as const) : ("end_turn" as const) };
					}).pipe(Effect.scoped),
				),

			cancel: ({ sessionId: id }) => control.interrupt(sessionId(id), { reason: "user" }).pipe(Effect.asVoid),
		};
	};
});

export * as Handlers from "./handlers.ts";
