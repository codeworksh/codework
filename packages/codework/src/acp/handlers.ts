import type * as Acp from "@agentclientprotocol/sdk";
import {
	Control,
	EventList,
	type EventSchema,
	type Harness,
	PromptSchema,
	Session,
	SessionStore,
	ThreadStore,
} from "@codeworksh/harness/effect";
import { DateTime, Effect, Fiber, type Layer, Option, Schema, Stream } from "effect";
import pkg from "../../package.json" with { type: "json" };
import { Agent } from "./agent.ts";
import { Config } from "./config.ts";
import { Feed } from "./feed.ts";

const PAGE_SIZE = 50;

const isRequestError = Schema.is(Agent.RequestError);
const isNotFound = Schema.is(SessionStore.SessionNotFoundError);
const isConflict = Schema.is(Control.PromptConflictError);
const isInvalidPrompt = Schema.is(PromptSchema.InvalidPromptError);
const isLLMEnded = Schema.is(EventList.LLMEnded);
const isSucceeded = Schema.is(EventList.ExecutionSucceeded);
const isFailed = Schema.is(EventList.ExecutionFailed);
const isInterrupted = Schema.is(EventList.ExecutionInterrupted);
const isSettled = (event: EventSchema.Payload) => isSucceeded(event) || isFailed(event) || isInterrupted(event);

/** Harness failures as JSON-RPC errors; handlers raise protocol-level ones directly. */
const toRequestError = (error: { readonly message: string }): Agent.RequestError => {
	if (isRequestError(error)) return error;
	if (isNotFound(error)) return Agent.RequestError.resourceNotFound(`Session not found: ${error.sessionId}`);
	if (isConflict(error)) return Agent.RequestError.invalidRequest(error.message);
	if (isInvalidPrompt(error)) return Agent.RequestError.invalidParams(error.message);
	return Agent.RequestError.internalError(error.message);
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
					return yield* Agent.RequestError.invalidParams(`Unsupported binary resource: ${block.resource.uri}`);
				}
				break;
			default:
				return yield* Agent.RequestError.invalidParams(`Unsupported prompt content: ${block.type}`);
		}
	}
	return parts;
});

const threadId = (id: string) => Session.ThreadSchema.ID.make(id);

type Services = Layer.Success<ReturnType<typeof Harness.layer>>;

export const make = Effect.gen(function* () {
	const control = yield* Control.Service;
	const sessions = yield* SessionStore.Service;
	const threads = yield* ThreadStore.Service;
	// Handlers run on the agent's fibers, outside this layer; they carry the harness with them.
	const context = yield* Effect.context<Services>();

	const running = new Set<string>();

	// Every thread is an ACP session of its own. The main thread keeps the CodeWork session's id,
	// so a session an editor knew before it had forks still loads; any other thread goes by its id.
	const acpId = (thread: { readonly originKind: string; readonly sessionId: string; readonly id: string }) =>
		thread.originKind === "main" ? thread.sessionId : thread.id;

	/** The CodeWork session and thread an ACP session id names. */
	const resolve = Effect.fn("ACP.resolve")(function* (id: string) {
		const session = yield* sessions.get(id);
		if (Option.isSome(session)) {
			const main = yield* threads.main(session.value.id);
			if (Option.isSome(main)) return { session: session.value, threadId: threadId(main.value.id) };
		}
		const thread = yield* threads.get(id);
		if (Option.isSome(thread)) {
			const owner = yield* sessions.get(thread.value.sessionId);
			if (Option.isSome(owner)) return { session: owner.value, threadId: threadId(thread.value.id) };
		}
		return yield* new SessionStore.SessionNotFoundError({ sessionId: id });
	});

	const attach = Effect.fn("ACP.attach")(function* (id: string) {
		const { session, threadId } = yield* resolve(id);
		const thread = yield* Session.attach({ sessionId: session.id, threadId });
		return { thread, hostDir: Option.getOrUndefined(session.hostDir) };
	});

	return (client: Agent.Client): Agent.Handlers => {
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
						sessionCapabilities: { list: {}, fork: {} },
					},
				}),

			newSession: ({ cwd }) =>
				run(
					Effect.gen(function* () {
						const handle = yield* Session.create({ directory: cwd, hostDir: cwd });
						const current = yield* Session.configuration(handle.main.id);
						return { sessionId: handle.id, configOptions: yield* Config.options(current, cwd) };
					}),
				),

			loadSession: ({ sessionId: id }) =>
				run(
					Effect.gen(function* () {
						const { thread, hostDir } = yield* attach(id);
						const current = yield* Session.configuration(thread.id);
						// A fork replays its whole line, the part it inherits included.
						for (const entry of yield* thread.history()) {
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
						const owners = new Map((yield* sessions.list()).map((row) => [row.id, row]));
						const all = yield* threads.list();
						const titles = new Map(all.map((thread) => [thread.id, Option.getOrUndefined(thread.title)]));
						const rows = all
							.flatMap((thread) => {
								const session = owners.get(thread.sessionId);
								return session === undefined ? [] : [{ thread, session }];
							})
							.filter(({ session }) => cwd == null || Option.getOrUndefined(session.hostDir) === cwd)
							.sort((a, b) =>
								DateTime.Order(
									b.thread.updatedAt ?? b.thread.createdAt,
									a.thread.updatedAt ?? a.thread.createdAt,
								),
							);
						const offset = cursor == null ? 0 : Number(cursor);
						if (!Number.isSafeInteger(offset) || offset < 0) {
							return yield* Agent.RequestError.invalidParams(`Invalid cursor: ${cursor}`);
						}
						const next = offset + PAGE_SIZE;
						return {
							sessions: rows.slice(offset, next).map(({ thread, session }) => ({
								sessionId: acpId(thread),
								cwd: Option.getOrElse(session.hostDir, () => session.directory),
								// A fork is untitled until its own first prompt; it reads as its source until then.
								title:
									titles.get(thread.id) ??
									Option.match(thread.originThreadId, {
										onNone: () => undefined,
										onSome: (origin) => titles.get(origin),
									}) ??
									null,
								updatedAt: DateTime.formatIso(thread.updatedAt ?? thread.createdAt),
							})),
							...(next < rows.length ? { nextCursor: String(next) } : {}),
						};
					}),
				),

			forkSession: ({ sessionId: id }) =>
				run(
					Effect.gen(function* () {
						const { thread, hostDir } = yield* attach(id);
						// ACP forks the conversation as it stands: at its last committed entry, of any type, so
						// a trailing tool result or compaction comes along.
						const last = (yield* thread.history()).findLast(({ entry }) => entry.state === "committed");
						if (last === undefined) {
							return yield* Agent.RequestError.invalidRequest(
								"Nothing to fork yet: the session has no messages",
							);
						}
						const forked = yield* thread.fork({ entryId: last.entry.id });
						const current = yield* Session.configuration(forked.thread.id);
						return { sessionId: forked.thread.id, configOptions: yield* Config.options(current, hostDir) };
					}),
				),

			setConfigOption: (request) =>
				run(
					Effect.gen(function* () {
						const { session, threadId } = yield* resolve(request.sessionId);
						const hostDir = Option.getOrUndefined(session.hostDir);
						const value = String(request.value);
						let runtime: Session.RuntimeInput;
						if (request.configId === Config.MODEL) {
							const model = Option.getOrUndefined(Config.parseModel(value));
							if (model === undefined || !(yield* Config.known(model, hostDir))) {
								return yield* Agent.RequestError.invalidParams(`Unknown model: ${value}`);
							}
							runtime = { model };
						} else if (request.configId === Config.THOUGHT_LEVEL) {
							if (!Config.isThinkingLevel(value)) {
								return yield* Agent.RequestError.invalidParams(`Unknown thinking level: ${value}`);
							}
							runtime = { thinkingLevel: value };
						} else {
							return yield* Agent.RequestError.invalidParams(`Unknown config option: ${request.configId}`);
						}
						const thread = yield* Session.attach({ sessionId: session.id, threadId, ...runtime });
						return { configOptions: yield* Config.options(yield* Session.configuration(thread.id), hostDir) };
					}),
				),

			prompt: ({ sessionId: id, prompt }) =>
				run(
					Effect.gen(function* () {
						const parts = yield* promptParts(prompt);
						const { thread: handle } = yield* attach(id);
						// Keyed by thread: main answers to its session id and its own thread id alike.
						if (running.has(handle.id)) {
							return yield* Agent.RequestError.invalidRequest("A prompt is already running for this session");
						}
						running.add(handle.id);
						yield* Effect.addFinalizer(() => Effect.sync(() => running.delete(handle.id)));

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

						// The harness titles a thread from its first prompt; tell the editor.
						const { title } = yield* handle.info;
						if (title !== undefined && title !== before) {
							yield* client
								.sessionUpdate({ sessionId: id, update: { sessionUpdate: "session_info_update", title } })
								.pipe(Effect.ignore);
						}

						if (Option.isNone(end) || isInterrupted(end.value)) return { stopReason: "cancelled" as const };
						if (isFailed(end.value)) return yield* Agent.RequestError.internalError(end.value.data.error.message);
						return { stopReason: reason === "length" ? ("max_tokens" as const) : ("end_turn" as const) };
					}).pipe(Effect.scoped),
				),

			cancel: ({ sessionId: id }) =>
				resolve(id).pipe(
					Effect.flatMap((found) => control.interrupt(found.threadId, { reason: "user" })),
					Effect.ignore,
					Effect.provide(context),
				),
		};
	};
});

export * as Handlers from "./handlers.ts";
