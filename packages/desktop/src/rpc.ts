import { EventList, type EventSchema, Session } from "@codeworksh/harness/effect";
import { Deferred, Effect, Layer, Predicate, Schema, Stream } from "effect";
import { Client } from "../../codework/src/server/client.ts";
import type { SessionInfo } from "../../codework/src/server/contract.ts";
import { Envelope } from "../../codework/src/server/envelope.ts";
import type { LiveEvent, SessionRow } from "./bridge.ts";

export type Handle = {
	readonly url: string;
	readonly list: Effect.Effect<ReadonlyArray<SessionRow>, unknown>;
	readonly create: (input?: {
		readonly title?: string;
		readonly hostDir?: string;
	}) => Effect.Effect<SessionRow, unknown>;
	readonly prompt: (input: { readonly sessionId: string; readonly text: string }) => Effect.Effect<void, unknown>;
};

const toRow = (info: SessionInfo): SessionRow => ({
	id: info.id,
	title: info.title,
	directory: info.directory,
	...(info.hostDir === undefined ? {} : { hostDir: info.hostDir }),
});

const sessionIdOf = (event: EventSchema.Payload): string | undefined => {
	if (!Predicate.hasProperty(event.data, "sessionId") || typeof event.data.sessionId !== "string") return undefined;
	return event.data.sessionId;
};

export const toLiveEvent = (event: EventSchema.Payload): LiveEvent | undefined => {
	const sessionId = sessionIdOf(event);
	if (sessionId === undefined) return undefined;
	if (Schema.is(EventList.Prompted)(event)) {
		return { kind: "user", sessionId, id: event.data.messageId, content: event.data.prompt.text };
	}
	if (Schema.is(EventList.LLMTextDelta)(event)) return { kind: "delta", sessionId, delta: event.data.delta };
	if (Schema.is(EventList.LLMTextEnd)(event)) {
		return { kind: "assistant", sessionId, id: event.data.messageId, content: event.data.content };
	}
	if (Schema.is(EventList.ExecutionSucceeded)(event)) return { kind: "ended", sessionId, outcome: "succeeded" };
	if (Schema.is(EventList.ExecutionFailed)(event)) {
		return { kind: "ended", sessionId, outcome: "failed", message: event.data.error.message };
	}
	if (Schema.is(EventList.ExecutionInterrupted)(event)) return { kind: "ended", sessionId, outcome: "interrupted" };
	return undefined;
};

/**
 * Open one RPC socket, wait for `server.connected`, then keep the event feed
 * alive. The caller owns the scope that holds the socket.
 */
export const connect = Effect.fn("Desktop.connect")(function* (url: string, publish: (event: LiveEvent) => void) {
	const context = yield* Layer.build(Client.layer(url));
	const rpc = yield* Client.make.pipe(Effect.provideContext(context));
	const ready = yield* Deferred.make<void>();

	yield* rpc["event.subscribe"]({}).pipe(
		Stream.runForEach(
			Effect.fnUntraced(function* (envelope) {
				if (envelope.type === Envelope.Connected.type) {
					yield* Deferred.succeed(ready, undefined);
					return;
				}
				const event = yield* Envelope.decode(envelope).pipe(
					Effect.catchTag("UnknownEventTypeError", () => Effect.void),
				);
				if (event === undefined) return;
				const live = toLiveEvent(event);
				if (live !== undefined) publish(live);
			}),
		),
		Effect.provideContext(context),
		Effect.forkScoped,
	);

	yield* Deferred.await(ready);

	return {
		url,
		list: rpc["session.list"]({}).pipe(
			Effect.provideContext(context),
			Effect.map((rows) => rows.map(toRow)),
		),
		create: (input) =>
			rpc["session.create"]({
				...(input?.title === undefined ? {} : { title: input.title }),
				...(input?.hostDir === undefined ? {} : { hostDir: Session.AbsolutePath.make(input.hostDir) }),
			}).pipe(Effect.provideContext(context), Effect.map(toRow)),
		prompt: (input) =>
			rpc["session.prompt"]({
				sessionId: Session.SessionSchema.ID.make(input.sessionId),
				text: input.text,
				delivery: "followUp",
			}).pipe(Effect.provideContext(context)),
	} satisfies Handle;
});
