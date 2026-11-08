import { EventList, type EventSchema, optional, Session } from "@codeworksh/harness/effect";
import { NodeSocket } from "@effect/platform-node";
import { Deferred, Effect, Layer, Schema, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
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
 * Threads are shared, so the stream carries other clients' work too and every
 * terminal event has to be attributed before it is believed. A terminal that
 * arrives before our own prompt is promoted belongs to somebody else's drain:
 * it is remembered rather than raised, and forgotten the moment our prompt is
 * promoted. It only becomes our outcome if the session reaches idle having
 * never promoted us -- at which point it is the best explanation available for
 * why our prompt never ran.
 */
export const run = Effect.fn("Client.run")(function* <E, R>(
	rpc: Client,
	input: { sessionId: Session.SessionSchema.ID; threadId: Session.ThreadSchema.ID; text: string },
	render: (event: EventSchema.Payload) => Effect.Effect<void, E, R>,
) {
	const id = Session.SessionMessageSchema.ID.create();
	let admitted = false;
	let promoted = false;
	let settled = false;
	// By log position, since notifications may arrive out of order: a run that started after our
	// admission is one our prompt woke, so its failure before promoting us is ours. A run already going
	// fails on its own, and parks our prompt behind it.
	let admittedAt: number | undefined;
	const starts: Array<number> = [];
	// Runs that ended before promoting us, failed ones with their error.
	const ends: Array<{ readonly at: number; readonly error: ExecutionError | undefined }> = [];
	const ours = () =>
		ends.findLast(({ at, error }) => {
			const start = Math.max(...starts.filter((seq) => seq < at));
			return error !== undefined && admittedAt !== undefined && start > admittedAt;
		})?.error;
	// Raised once a run ends after our admission without our prompt in it: the session may be about to
	// go idle, and only idleness proves our prompt is never running.
	const stalled = yield* Deferred.make<void>();

	const terminal = (event: EventSchema.Payload): ExecutionError | undefined => {
		if (Schema.is(EventList.ExecutionInterrupted)(event))
			return new ExecutionError({
				type: "aborted",
				message: event.data.reason === "shutdown" ? "Server stopped the session" : "Session interrupted",
			});
		if (Schema.is(EventList.RunFailed)(event))
			return new ExecutionError({ type: `run.${event.data.reason}`, message: event.data.message });
		if (Schema.is(EventList.ExecutionFailed)(event))
			return new ExecutionError({
				type: event.data.error.type,
				message: event.data.error.message,
				...(event.data.error.status === undefined ? {} : { status: event.data.error.status }),
			});
		return undefined;
	};

	const consume = rpc["event.subscribe"]({ threadId: input.threadId }).pipe(
		Stream.mapEffect(
			Effect.fnUntraced(function* (envelope) {
				if (envelope.type === Envelope.Connected.type) {
					yield* rpc["thread.prompt"]({ ...input, id, delivery: "followUp" });
					return;
				}
				const event = yield* Envelope.decode(envelope).pipe(
					Effect.catchTag("UnknownEventTypeError", () => Effect.void),
				);
				if (event === undefined) return;
				const seq = event.durable?.seq;
				if (Schema.is(EventList.ExecutionStarted)(event) && seq !== undefined) starts.push(seq);
				if (Schema.is(EventList.PromptAdmitted)(event) && event.data.messageId === id) {
					admitted = true;
					admittedAt = seq;
				}
				if (Schema.is(EventList.Prompted)(event) && event.data.messageId === id) promoted = true;

				const ended = terminal(event);
				const succeeded = Schema.is(EventList.ExecutionSucceeded)(event);
				if (!promoted) {
					// Kept whatever arrives first: our admission comes from another fiber than the runs, so a
					// run's end may be notified before it.
					if ((ended !== undefined || succeeded) && seq !== undefined) ends.push({ at: seq, error: ended });
					if (admitted && ends.some(({ at }) => admittedAt === undefined || at > admittedAt))
						yield* Deferred.succeed(stalled, undefined);
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
		Effect.andThen(rpc["thread.wait"]({ sessionId: input.sessionId, threadId: input.threadId })),
		Effect.andThen(rpc["thread.message"]({ sessionId: input.sessionId, threadId: input.threadId, messageId: id })),
		Effect.andThen(({ found }) =>
			found
				? Effect.never
				: Effect.sync(() => {
						abandoned = true;
					}),
		),
	);

	yield* Effect.raceFirst(consume, reconcile);
	if (settled) return;
	if (abandoned) return yield* ours() ?? new ExecutionError({ type: "unknown", message: "Prompt was not promoted" });
	return yield* new ExecutionError({
		type: "transport.disconnected",
		message: "Event stream ended before the prompt finished; its output was not rendered",
	});
});

export * as Client from "./client.ts";
