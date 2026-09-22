import { Control, EventSchema, PromptSchema, Sandbox, Session, SessionStore, State } from "@codeworksh/harness/effect";
import { Effect, Option, Stream } from "effect";
import { Contract, type RuntimeConfig, type SandboxInfo, type SessionInfo } from "./contract.ts";
import { Envelope } from "./envelope.ts";
import { EventFeed } from "./feed.ts";
import { OpenAICodexAuth } from "./oauth-openai-codex.ts";

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

const releaseOnFailure = (selection: Effect.Success<ReturnType<typeof Sandbox.resolve>> | undefined) =>
	selection?.created && selection.info !== undefined
		? Sandbox.stop(selection.info.id).pipe(Effect.catchCause(Effect.logError))
		: Effect.void;

export const layer = Contract.Api.toLayer(
	Effect.gen(function* () {
		const control = yield* Control.Service;
		const feed = yield* EventFeed.Service;
		const sessions = yield* SessionStore.Service;
		const state = yield* State.Service;
		const openAICodexAuth = yield* OpenAICodexAuth.Service;

		return Contract.Api.of({
			"openaiCodex.auth.save": ({ credentials }) => openAICodexAuth.save(credentials),
			"openaiCodex.auth.status": () => openAICodexAuth.status,
			"openaiCodex.auth.refresh": () => openAICodexAuth.refresh,
			"openaiCodex.auth.logout": () => openAICodexAuth.logout,
			"session.create": Effect.fnUntraced(function* ({ title, directory, hostDir, sandbox, runtime }) {
				const selection = sandbox === undefined ? undefined : yield* Sandbox.resolve(sandbox);
				const selected = selection?.info;
				const handle = yield* Session.create({
					...(title === undefined ? {} : { title }),
					...(directory === undefined ? {} : { directory }),
					// Passed through as given, never defaulted to the server's own directory: a
					// session the client did not place has no project, which is a normal state.
					...(hostDir === undefined ? {} : { hostDir }),
					...(selected === undefined ? {} : { sandbox: selected }),
					...runtimeInput(runtime),
				}).pipe(Effect.onError(() => releaseOnFailure(selection)));
				return toSessionInfo(yield* handle.info);
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
			"session.link": Effect.fnUntraced(function* ({ sessionId, hostDir }) {
				const handle = yield* Session.link({ sessionId, hostDir: hostDir ?? null });
				return toSessionInfo(yield* handle.info);
			}),
			"session.relink": Effect.fnUntraced(function* ({ sessionId, sandbox, directory }) {
				const selection = sandbox === undefined ? undefined : yield* Sandbox.resolve(sandbox);
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
					prompt: PromptSchema.Prompt.make({ text }),
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
				return toSandboxInfo(yield* Sandbox.create({ driver }));
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
