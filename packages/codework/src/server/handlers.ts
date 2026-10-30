import { Model } from "@codeworksh/aikit";
import {
	Control,
	Event,
	EventList,
	EventRegistry,
	EventSchema,
	ModelCatalog,
	Project,
	PromptSchema,
	Sandbox,
	Session,
	SessionStore,
	Settings,
	State,
	ThreadSchema,
	ThreadStore,
} from "@codeworksh/harness/effect";
import { DateTime, Effect, Option, Stream } from "effect";
import {
	Contract,
	type HistoryEntry,
	type LogSynced,
	type RuntimeConfig,
	type SandboxInfo,
	type SessionInfo,
	type ThreadInfo,
} from "./contract.ts";
import { type EncodingError, Envelope, type EventEnvelope } from "./envelope.ts";
import { EventFeed } from "./feed.ts";
import { Identity } from "./identity.ts";
import { OAuth } from "./oauth.ts";
import { MessagePart } from "./part.ts";

const toSandboxInfo = (info: Sandbox.Info): SandboxInfo => ({
	id: info.id,
	driver: info.driver,
	kind: info.kind,
	providerResourceId: info.providerResourceId,
	ownership: info.ownership,
	status: info.status,
	usage: info.usage,
	refCount: info.refCount,
	createdAt: info.createdAt,
	updatedAt: info.updatedAt,
});

const toSessionInfo = (info: Session.Info): SessionInfo => ({
	id: info.id,
	directory: info.directory,
	...(info.hostDir === undefined ? {} : { hostDir: info.hostDir }),
	...(info.sandbox === undefined ? {} : { sandbox: toSandboxInfo(info.sandbox) }),
	...(info.project === undefined ? {} : { project: info.project }),
	updatedAt: info.updatedAt,
	mainThreadId: info.mainThreadId,
});

const toThreadInfo = (info: Session.ThreadInfo): ThreadInfo => ({
	id: info.id,
	origin: info.origin,
	...(info.title === undefined ? {} : { title: info.title }),
	updatedAt: info.updatedAt,
	...(info.model === undefined ? {} : { model: info.model }),
	...(info.thinkingLevel === undefined ? {} : { thinkingLevel: info.thinkingLevel }),
	...(info.placement === undefined ? {} : { placement: info.placement }),
	...(info.parked ? { parked: true } : {}),
	usage: info.usage,
	session: toSessionInfo(info.session),
});

// Wire configs name only the keys they set, so `undefined` never reaches the harness under
// exactOptionalPropertyTypes. Creating takes choices only; `null` clears nothing there.
const runtimeInput = (runtime: RuntimeConfig | undefined): Session.RuntimeInput => ({
	...(runtime?.model == null ? {} : { model: runtime.model }),
	...(runtime?.thinkingLevel == null ? {} : { thinkingLevel: runtime.thinkingLevel }),
});

const threadInfo = (threadId: ThreadSchema.ID) => Session.threadInfo(threadId).pipe(Effect.map(toThreadInfo));

// RpcServer's request span has no level, so it is Debug and drops every Info span under it.
// Provisioning a sandbox is worth exporting, so it starts a trace of its own.
const exported = <A, E, R>(name: string, self: Effect.Effect<A, E, R>) =>
	self.pipe(Effect.withSpan(name, { level: "Info", root: true }));

const releaseOnFailure = (selection: Effect.Success<ReturnType<typeof Sandbox.resolve>> | undefined) =>
	selection?.created && selection.info !== undefined
		? Sandbox.stop(selection.info.id).pipe(Effect.catchCause(Effect.logError))
		: Effect.void;

/** A `session.log` item for the wire: a stored event as its envelope, or the replay marker. */
const toLogItem =
	(registry: Envelope.Registry) =>
	(item: Event.LogItem): Effect.Effect<EventEnvelope | LogSynced, EncodingError> =>
		Event.isSynced(item)
			? Effect.succeed(item)
			: Envelope.encode(item, registry).pipe(
					// Every stored type is a kernel durable one, which the registry always knows.
					Effect.catchTag("UnknownEventTypeError", Effect.die),
				);

export const layer = Contract.Api.toLayer(
	Effect.gen(function* () {
		const control = yield* Control.Service;
		const feed = yield* EventFeed.Service;
		const sessions = yield* SessionStore.Service;
		const threads = yield* ThreadStore.Service;
		const resolve = (ref: Control.ThreadRef) =>
			control.resolve(ref).pipe(Effect.map((thread) => ThreadSchema.ID.make(thread.id)));
		const state = yield* State.Service;
		const oauth = yield* OAuth.Service;
		const identity = yield* Identity.Service;
		const events = yield* Event.Service;
		const registry = yield* EventRegistry.Service;

		return Contract.Api.of({
			"server.info": () => Effect.succeed({ pid: identity.pid, version: identity.version }),
			"auth.save": ({ credentials }) => oauth.save(credentials),
			"auth.status": ({ provider }) => oauth.status(provider),
			"auth.refresh": ({ provider }) => oauth.refresh(provider),
			"auth.logout": ({ provider }) => oauth.logout(provider),
			"session.create": Effect.fnUntraced(function* ({ title, directory, hostDir, sandbox, runtime, project }) {
				const selection =
					sandbox === undefined ? undefined : yield* exported("Server.session.create", Sandbox.resolve(sandbox));
				const selected = selection?.info;
				const handle = yield* Session.create({
					...(title === undefined ? {} : { title }),
					...(directory === undefined ? {} : { directory }),
					// Passed through as given, never defaulted to the server's own directory: a
					// session the client did not place has no project, which is a normal state.
					...(hostDir === undefined ? {} : { hostDir }),
					...(selected === undefined ? {} : { sandbox: selected }),
					...(project === undefined ? {} : { project }),
					...runtimeInput(runtime),
				}).pipe(Effect.onError(() => releaseOnFailure(selection)));
				return toThreadInfo(yield* handle.main.info);
			}),
			"model.list": Effect.fnUntraced(function* ({ hostDir }) {
				const filter = hostDir === undefined ? {} : { hostDir };
				const settings = yield* Settings.Service;
				const loaded = yield* settings.load(hostDir);
				const { model } = loaded;
				const providers = yield* ModelCatalog.available(filter);
				// Named from the whole catalog, so a default without credentials still reads as itself.
				const entry = (yield* ModelCatalog.effective(loaded.models))[model.provider]?.[model.id];
				return {
					providers: providers.flatMap((provider) => {
						const models = Object.values(provider.models);
						const first = models[0];
						return first === undefined
							? []
							: [
									{
										id: provider.id,
										name: first.provider.name,
										models: models.map((info) => ({
											id: info.id,
											name: info.name,
											thinkingLevels: Model.getSupportedThinkingLevels(info),
										})),
									},
								];
					}),
					default: {
						provider: model.provider,
						id: model.id,
						thinkingLevel: model.thinkingLevel,
						...(entry === undefined ? {} : { name: entry.name, providerName: entry.provider.name }),
					},
				};
			}),
			"project.rename": Effect.fnUntraced(function* ({ projectId, name }) {
				const renamed = yield* Project.rename({ projectId, name });
				return { id: renamed.id, name: renamed.name };
			}),
			"plugin.reload": Effect.fnUntraced(function* () {
				return yield* state.reload;
			}),
			"session.link": Effect.fnUntraced(function* ({ sessionId, hostDir }) {
				const handle = yield* Session.link({ sessionId, hostDir: hostDir ?? null });
				return toSessionInfo(yield* handle.info);
			}),
			"session.relink": Effect.fnUntraced(function* ({ sessionId, threadId, sandbox, directory }) {
				const selection =
					sandbox === undefined ? undefined : yield* exported("Server.session.relink", Sandbox.resolve(sandbox));
				const selected = selection?.info;
				const handle = yield* Session.relink({
					sessionId,
					...(threadId === undefined ? {} : { threadId }),
					...(selected === undefined ? {} : { sandbox: selected }),
					...(directory === undefined ? {} : { directory }),
				}).pipe(Effect.onError(() => releaseOnFailure(selection)));
				const thread = yield* handle.thread(threadId ?? ThreadSchema.MAIN);
				return toThreadInfo(yield* thread.info);
			}),
			"session.delete": Effect.fnUntraced(function* ({ sessionId }) {
				return { deleted: yield* Session.remove(sessionId) };
			}),
			"session.interrupt": Effect.fnUntraced(function* ({ sessionId }) {
				// Ack only: the wire answers "was there work to stop", and the caller
				// uses `thread.wait` when it needs cleanup to have finished.
				return { interrupted: yield* control.interruptSession(sessionId, { reason: "user" }) };
			}),
			"session.log": ({ sessionId, threadId, after, follow }) =>
				Stream.unwrap(
					Effect.gen(function* () {
						if (Option.isNone(yield* sessions.get(sessionId))) {
							return yield* new SessionStore.SessionNotFoundError({ sessionId });
						}
						return events
							.log({
								aggregateId: sessionId,
								follow: follow ?? false,
								...(after === undefined ? {} : { after }),
							})
							.pipe(
								Stream.filter(
									(item) =>
										threadId === undefined || Event.isSynced(item) || Envelope.ofThread(threadId)(item),
								),
								Stream.mapEffect(toLogItem(registry.get)),
							);
					}),
				),
			"thread.list": Effect.fnUntraced(function* ({ sessionId }) {
				const rows = yield* threads.list(sessionId);
				return yield* Effect.forEach(rows, (row) => threadInfo(ThreadSchema.ID.make(row.id)).pipe(Effect.orDie));
			}),
			"thread.info": Effect.fnUntraced(function* (ref) {
				return yield* threadInfo(yield* resolve(ref));
			}),
			"thread.configure": Effect.fnUntraced(function* ({ runtime, ...ref }) {
				const threadId = yield* resolve(ref);
				const change = {
					...(runtime.model === undefined ? {} : { model: runtime.model }),
					...(runtime.thinkingLevel === undefined ? {} : { thinkingLevel: runtime.thinkingLevel }),
				};
				if (Object.keys(change).length > 0) {
					yield* events.publish(EventList.ThreadConfigured, {
						sessionId: ref.sessionId,
						threadId,
						timestamp: yield* DateTime.now,
						change,
					});
				}
				return yield* threadInfo(threadId);
			}),
			"thread.fork": Effect.fnUntraced(function* ({ entryId, mode, ...ref }) {
				const forked = yield* threads.fork({
					threadId: yield* resolve(ref),
					entryId,
					...(mode === undefined ? {} : { mode }),
				});
				return {
					thread: yield* threadInfo(ThreadSchema.ID.make(forked.thread.id)),
					...(forked.text === undefined ? {} : { text: forked.text }),
				};
			}),
			"thread.history": Effect.fnUntraced(function* (ref) {
				const line = yield* threads.line(yield* resolve(ref));
				const entries = line.flatMap(({ entry, parts }): ReadonlyArray<HistoryEntry> =>
					entry.type === "user" || entry.type === "assistant"
						? [
								{
									id: entry.id,
									threadId: entry.threadId,
									seq: entry.seq,
									role: entry.type,
									state: entry.state,
									createdAt: DateTime.toEpochMillis(entry.createdAt),
									updatedAt: DateTime.toEpochMillis(entry.updatedAt),
									// A part this schema does not render (a future aikit type) is skipped, not fatal.
									parts: parts.flatMap((part) => Option.toArray(MessagePart.decode(part.data))),
								},
							]
						: [],
				);
				return { entries };
			}),
			"thread.queue": Effect.fnUntraced(function* (ref) {
				const pending = yield* control.pending(yield* resolve(ref));
				return {
					entries: pending.map((input) => ({
						id: input.id,
						delivery: input.delivery,
						text: PromptSchema.Prompt.text(input.prompt),
						createdAt: DateTime.toEpochMillis(input.timeCreated),
					})),
				};
			}),
			"thread.prompt": Effect.fnUntraced(function* ({ text, delivery, id, ...ref }) {
				const admitted = yield* control.prompt({
					...ref,
					prompt: PromptSchema.Prompt.fromText(text),
					...(delivery === undefined ? {} : { delivery }),
					...(id === undefined ? {} : { id }),
				});
				return { threadId: admitted.threadId };
			}),
			"thread.interrupt": Effect.fnUntraced(function* (ref) {
				// Ack only: the wire answers "was there work to stop", and the caller
				// uses `thread.wait` when it needs cleanup to have finished.
				return { interrupted: yield* control.interrupt(yield* resolve(ref), { reason: "user" }) };
			}),
			"thread.cancel": Effect.fnUntraced(function* ({ messageId, ...ref }) {
				return { cancelled: yield* control.cancel(yield* resolve(ref), messageId) };
			}),
			"thread.update": Effect.fnUntraced(function* ({ messageId, delivery, text, ...ref }) {
				const updated = yield* control.update(yield* resolve(ref), messageId, {
					...(delivery === undefined ? {} : { delivery }),
					...(text === undefined ? {} : { prompt: PromptSchema.Prompt.fromText(text) }),
				});
				return { updated };
			}),
			"thread.message": Effect.fnUntraced(function* ({ messageId, ...ref }) {
				// Scoped to the thread's line: an entry id is global, and a client should not learn
				// about conversations it did not ask for. An inherited prompt is in the thread's.
				const line = yield* threads.line(yield* resolve(ref));
				return { found: line.some(({ entry }) => entry.id === messageId) };
			}),
			"thread.wait": Effect.fnUntraced(function* (ref) {
				yield* control.wait(yield* resolve(ref));
			}),
			"sandbox.drivers": Effect.fnUntraced(function* () {
				const drivers = yield* Sandbox.drivers();
				return drivers.map(({ name, kind }) => ({ name, kind }));
			}),
			"sandbox.list": Effect.fnUntraced(function* () {
				return (yield* Sandbox.list()).map(toSandboxInfo);
			}),
			"sandbox.create": Effect.fnUntraced(function* ({ driver }) {
				return toSandboxInfo(yield* exported("Server.sandbox.create", Sandbox.create({ driver })));
			}),
			"sandbox.register": Effect.fnUntraced(function* ({ driver, providerResourceId }) {
				return toSandboxInfo(yield* Sandbox.register({ driver, providerResourceId }));
			}),
			"sandbox.stop": Effect.fnUntraced(function* ({ sandboxId }) {
				yield* Sandbox.stop(sandboxId);
			}),
			// Acquiring the feed subscription is the readiness barrier: `server.connected`
			// is only emitted once this client is registered, so a prompt admitted after
			// it cannot land in the gap.
			"event.subscribe": ({ threadId }) =>
				Stream.unwrap(
					feed.subscribe.pipe(
						Effect.map((events) =>
							Stream.make({ id: EventSchema.ID.create(), type: Envelope.Connected.type, data: {} }).pipe(
								Stream.concat(
									threadId === undefined ? events : events.pipe(Stream.filter(Envelope.ofThread(threadId))),
								),
							),
						),
					),
				),
		});
	}),
);

export * as Handlers from "./handlers.ts";
