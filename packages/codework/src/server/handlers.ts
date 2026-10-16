import {
	Control,
	Event,
	EventRegistry,
	EventSchema,
	Project,
	PromptSchema,
	Sandbox,
	Session,
	SessionStore,
	State,
} from "@codeworksh/harness/effect";
import { DateTime, Effect, Option, Stream } from "effect";
import {
	Contract,
	type HistoryEntry,
	type LogSynced,
	type RuntimeConfig,
	type SandboxInfo,
	type SessionInfo,
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
	title: info.title,
	directory: info.directory,
	...(info.hostDir === undefined ? {} : { hostDir: info.hostDir }),
	...(info.sandbox === undefined ? {} : { sandbox: toSandboxInfo(info.sandbox) }),
	...(info.project === undefined ? {} : { project: info.project }),
	updatedAt: info.updatedAt,
	...(info.model === undefined ? {} : { model: info.model }),
});

// Wire configs name only the keys they set, so `undefined` never reaches the
// harness inputs under exactOptionalPropertyTypes.
const runtimeInput = (runtime: RuntimeConfig | undefined): Session.RuntimeInput => ({
	...(runtime?.model === undefined ? {} : { model: runtime.model }),
	...(runtime?.thinkingLevel === undefined ? {} : { thinkingLevel: runtime.thinkingLevel }),
});

const sessionInfo = Effect.fn("Server.sessionInfo")(function* (sessionId: Session.SessionSchema.ID) {
	const found = yield* Session.get(sessionId);
	if (Option.isNone(found)) return yield* new SessionStore.SessionNotFoundError({ sessionId });
	return toSessionInfo(yield* found.value.info);
});

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
				return toSessionInfo(yield* handle.info);
			}),
			"project.rename": Effect.fnUntraced(function* ({ projectId, name }) {
				const renamed = yield* Project.rename({ projectId, name });
				return { id: renamed.id, name: renamed.name };
			}),
			"plugin.reload": Effect.fnUntraced(function* () {
				return yield* state.reload;
			}),
			"session.list": Effect.fnUntraced(function* () {
				const rows = yield* sessions.list();
				return yield* Effect.forEach(rows, (row) => sessionInfo(row.id).pipe(Effect.orDie));
			}),
			"session.configure": Effect.fnUntraced(function* ({ sessionId, runtime }) {
				const handle = yield* Session.attach({ sessionId, ...runtimeInput(runtime) });
				return toSessionInfo(yield* handle.info);
			}),
			"session.info": Effect.fnUntraced(function* ({ sessionId }) {
				return yield* sessionInfo(sessionId);
			}),
			"session.history": Effect.fnUntraced(function* ({ sessionId }) {
				if (Option.isNone(yield* sessions.get(sessionId))) {
					return yield* new SessionStore.SessionNotFoundError({ sessionId });
				}
				const path = yield* sessions.path(sessionId);
				const entries = path.flatMap(({ entry, parts }): ReadonlyArray<HistoryEntry> =>
					entry.type === "user" || entry.type === "assistant"
						? [
								{
									id: entry.id,
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
			"session.log": ({ sessionId, after, follow }) =>
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
							.pipe(Stream.mapEffect(toLogItem(registry.get)));
					}),
				),
			"session.link": Effect.fnUntraced(function* ({ sessionId, hostDir }) {
				const handle = yield* Session.link({ sessionId, hostDir: hostDir ?? null });
				return toSessionInfo(yield* handle.info);
			}),
			"session.relink": Effect.fnUntraced(function* ({ sessionId, sandbox, directory }) {
				const selection =
					sandbox === undefined ? undefined : yield* exported("Server.session.relink", Sandbox.resolve(sandbox));
				const selected = selection?.info;
				const handle = yield* Session.relink({
					sessionId,
					...(selected === undefined ? {} : { sandbox: selected }),
					...(directory === undefined ? {} : { directory }),
				}).pipe(Effect.onError(() => releaseOnFailure(selection)));
				return toSessionInfo(yield* handle.info);
			}),
			"session.prompt": Effect.fnUntraced(function* ({ sessionId, text, delivery, id }) {
				yield* control.prompt({
					sessionId,
					prompt: PromptSchema.Prompt.fromText(text),
					...(delivery === undefined ? {} : { delivery }),
					...(id === undefined ? {} : { id }),
				});
			}),
			"session.interrupt": Effect.fnUntraced(function* ({ sessionId }) {
				// Ack only: the wire answers "was there work to stop", and the caller
				// uses `session.wait` when it needs cleanup to have finished.
				return { interrupted: yield* control.interrupt(sessionId, { reason: "user" }) };
			}),
			"session.message": Effect.fnUntraced(function* ({ sessionId, messageId }) {
				const found = yield* sessions.entry(messageId);
				// Scoped to the session the caller named: an entry id is global, and a
				// client should not learn about conversations it did not ask for.
				return { found: Option.isSome(found) && found.value.entry.sessionId === sessionId };
			}),
			"session.wait": Effect.fnUntraced(function* ({ sessionId }) {
				yield* control.wait(sessionId);
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
			"event.subscribe": () =>
				Stream.unwrap(
					feed.subscribe.pipe(
						Effect.map((events) =>
							Stream.make({ id: EventSchema.ID.create(), type: Envelope.Connected.type, data: {} }).pipe(
								Stream.concat(events),
							),
						),
					),
				),
		});
	}),
);

export * as Handlers from "./handlers.ts";
