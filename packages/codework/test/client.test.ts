import { EventList, EventSchema, PromptSchema, Session } from "@codeworksh/harness/effect";
import { DateTime, Effect, Exit, Queue, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Client } from "../src/server/client.ts";
import { Envelope, type EventEnvelope } from "../src/server/envelope.ts";

/*
 * Notifications of one thread may arrive out of log order: a prompt's admission is published by the
 * RPC that sent it, a run's events by the run. A real server cannot be made to reorder them on
 * demand, so a stub delivers them in the order under test.
 */

const sessionId = Session.SessionSchema.ID.create();
const threadId = Session.ThreadSchema.ID.create();
const durable = (seq: number) => ({ aggregateId: sessionId, seq, version: 1 });

const envelope = (type: string, seq: number, data: Record<string, unknown>) =>
	Envelope.encode({
		id: EventSchema.ID.create(),
		type,
		durable: durable(seq),
		data: { sessionId, threadId, timestamp: DateTime.makeUnsafe(seq), ...data },
	} as EventSchema.Payload);

/** A client whose server answers its prompt with `events`, delivered in the order given. */
const stub = (
	events: (messageId: Session.SessionMessageSchema.ID) => ReadonlyArray<ReturnType<typeof Envelope.encode>>,
) =>
	Effect.gen(function* () {
		const queue = yield* Queue.unbounded<EventEnvelope>();
		yield* Queue.offer(
			queue,
			yield* Envelope.encode({ id: EventSchema.ID.create(), type: Envelope.Connected.type, data: {} }),
		);
		const rpc = {
			"event.subscribe": () => Stream.fromQueue(queue),
			"thread.prompt": ({ id }: { readonly id: Session.SessionMessageSchema.ID }) =>
				Effect.forEach(events(id), (next) => Effect.flatMap(next, (one) => Queue.offer(queue, one))).pipe(
					Effect.orDie,
					Effect.as({ threadId }),
				),
			"thread.wait": () => Effect.void,
			"thread.message": () => Effect.succeed({ found: false }),
		};
		return rpc as unknown as Client.Client;
	});

const admitted = (messageId: Session.SessionMessageSchema.ID, seq: number) =>
	envelope(EventList.PromptAdmitted.type, seq, {
		messageId,
		prompt: PromptSchema.Prompt.fromText("ours"),
		delivery: "followUp",
	});
const started = (seq: number) => envelope(EventList.ExecutionStarted.type, seq, { resumed: false });
const failed = (seq: number) =>
	envelope(EventList.ExecutionFailed.type, seq, { error: { type: "provider", message: "their run failed" } });

const run = (events: Parameters<typeof stub>[0]) =>
	Effect.gen(function* () {
		const rpc = yield* stub(events);
		return yield* Client.run(rpc, { sessionId, threadId, text: "ours" }, () => Effect.void).pipe(Effect.exit);
	}).pipe(Effect.timeout("5 seconds"), Effect.runPromise);

const failure = (exit: Exit.Exit<void, unknown>) =>
	Exit.isFailure(exit) ? (exit.cause.reasons[0] as { readonly error?: unknown } | undefined)?.error : undefined;

describe("Client.run attribution", () => {
	// Another client's run started at 10 and failed at 12; our prompt was admitted at 11, between them.
	it("does not hang or adopt another run's failure notified before its own admission", async () => {
		const exit = await run((id) => [started(10), failed(12), admitted(id, 11)]);
		expect(failure(exit)).toMatchObject({ type: "unknown", message: "Prompt was not promoted" });
	});

	it("does not adopt another run's failure when its start is notified after the admission", async () => {
		const exit = await run((id) => [admitted(id, 11), started(10), failed(12)]);
		expect(failure(exit)).toMatchObject({ type: "unknown", message: "Prompt was not promoted" });
	});

	it("adopts the failure of the run its prompt woke, before promoting it", async () => {
		const exit = await run((id) => [admitted(id, 11), started(12), failed(13)]);
		expect(failure(exit)).toMatchObject({ type: "provider", message: "their run failed" });
	});
});
