import { EventList, type EventSchema, optional, Session } from "@codeworksh/harness/effect";
import { NodeSocket } from "@effect/platform-node";
import { Deferred, Effect, Layer, Predicate, Schema, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { Contract } from "./contract.ts";
import { Envelope } from "./envelope.ts";

export const make = RpcClient.make(Contract.Api);
export type Client = Effect.Success<typeof make>;

export const layer = (url: string) =>
	RpcClient.layerProtocolSocket().pipe(
		Layer.provide(NodeSocket.layerWebSocket(url)),
		Layer.provide(RpcSerialization.layerNdjson),
	);

/** A server-side failure as the client sees it: the category, not the cause. */
export class ExecutionError extends Schema.TaggedError<ExecutionError>()("Client.ExecutionError", {
	type: Schema.String,
	message: Schema.String,
	status: optional(Schema.Int),
}) {}

/**
 * Runs one prompt against a server and renders its output.
 *
 * Sessions are shared, so the stream carries other clients' work too and every
 * terminal event has to be attributed before it is believed. A terminal that
 * arrives before our own prompt is promoted belongs to somebody else's drain:
 * it is remembered rather than raised, and forgotten the moment our prompt is
 * promoted. It only becomes our outcome if the session reaches idle having
 * never promoted us -- at which point it is the best explanation available for
 * why our prompt never ran.
 */
export const run = Effect.fn("Client.run")(function* <E, R>(
	rpc: Client,
	input: { sessionId: Session.SessionSchema.ID; text: string },
	render: (event: EventSchema.Payload) => Effect.Effect<void, E, R>,
) {
	const id = Session.SessionMessageSchema.ID.create();
	let admitted = false;
	let promoted = false;
	let settled = false;
	let unattributed: ExecutionError | undefined;
	// Raised once a busy period ends without our prompt in it: the session may be
	// about to go idle, and only idleness proves our prompt is never running.
	const stalled = yield* Deferred.make<void>();

	const terminal = (event: EventSchema.Payload): ExecutionError | undefined => {
		if (Schema.is(EventList.ExecutionInterrupted)(event))
			return new ExecutionError({
				type: "aborted",
				message: event.data.reason === "shutdown" ? "Server stopped the session" : "Session interrupted",
			});
		if (Schema.is(EventList.ExecutionFailed)(event))
			return new ExecutionError({
				type: event.data.error.type,
				message: event.data.error.message,
				...(event.data.error.status === undefined ? {} : { status: event.data.error.status }),
			});
		return undefined;
	};

	const consume = rpc["event.subscribe"]({}).pipe(
		Stream.mapEffect(
			Effect.fnUntraced(function* (envelope) {
				if (envelope.type === Envelope.Connected.type) {
					yield* rpc["session.prompt"]({ ...input, id, delivery: "followUp" });
					return;
				}
				const event = yield* Envelope.decode(envelope).pipe(
					Effect.catchTag("UnknownEventTypeError", () => Effect.void),
				);
				if (
					event === undefined ||
					!Predicate.hasProperty(event.data, "sessionId") ||
					event.data.sessionId !== input.sessionId
				)
					return;
				if (Schema.is(EventList.PromptAdmitted)(event) && event.data.messageId === id) admitted = true;
				if (Schema.is(EventList.Prompted)(event) && event.data.messageId === id) {
					promoted = true;
					// Our prompt is running after all; whatever ended before it was not ours.
					unattributed = undefined;
				}
				if (!admitted) return;

				const ended = terminal(event);
				const succeeded = Schema.is(EventList.ExecutionSucceeded)(event);
				if (!promoted) {
					if (ended !== undefined) unattributed = ended;
					// A busy period that ended without us: wait for idle to find out
					// whether a successor still picks our prompt up.
					if (ended !== undefined || succeeded) yield* Deferred.succeed(stalled, undefined);
					return;
				}
				if (ended !== undefined) return yield* ended;
				if (succeeded) {
					settled = true;
					return;
				}
				yield* render(event);
			}),
		),
		Stream.takeUntil(() => settled),
		Stream.runDrain,
	);

	// Idle is the cue to reconcile, not the verdict. `wait` follows successors, so
	// it resolves only once the session is quiet -- then the projection says
	// whether our prompt was ever part of it. A prompt that did run leaves its
	// terminal in flight on the same socket, so the consumer is left alone to
	// finish; only a prompt that never materialized ends the run early.
	let abandoned = false;
	const reconcile = Deferred.await(stalled).pipe(
		Effect.andThen(rpc["session.wait"]({ sessionId: input.sessionId })),
		Effect.andThen(rpc["session.message"]({ sessionId: input.sessionId, messageId: id })),
		Effect.andThen(({ found }) =>
			found
				? Effect.never
				: Effect.sync(() => {
						abandoned = true;
					}),
		),
	);

	yield* Effect.raceFirst(consume, reconcile);
	if (settled) {
		yield* rpc["session.wait"]({ sessionId: input.sessionId });
		return;
	}
	if (abandoned)
		return yield* unattributed ?? new ExecutionError({ type: "unknown", message: "Prompt was not promoted" });
	return yield* new ExecutionError({
		type: "transport.disconnected",
		message: "Event stream ended before the prompt finished; its output was not rendered",
	});
});

export * as Client from "./client.ts";
