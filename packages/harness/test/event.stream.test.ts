import { DateTime, Deferred, Effect, Fiber, Layer, Ref, Stream } from "effect";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { EventList } from "../src/event/list.ts";
import { SessionMessageSchema } from "../src/session/message/schema.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { testEffect } from "./utils/effect.ts";

const layer = Layer.provideMerge(Event.layer, Database.layer(":memory:"));
const { effect: it, live: liveIt } = testEffect(layer);
const A = SessionSchema.ID.make("session_a");
const B = SessionSchema.ID.make("session_b");

describe("Event.stream", () => {
	it("replays durable events for only the selected session", () =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			const timestamp = yield* DateTime.now;
			yield* events.publish(EventList.TurnEnded, {
				timestamp,
				sessionId: B,
				messageId: SessionMessageSchema.ID.make("message_b"),
			});
			yield* events.publish(EventList.TurnEnded, {
				timestamp,
				sessionId: A,
				messageId: SessionMessageSchema.ID.make("message_a"),
			});

			const replay = yield* events.stream({ sessionId: A, after: -1 }).pipe(Stream.take(1), Stream.runCollect);
			expect(Array.from(replay).map((event) => (event.data as { readonly sessionId: string }).sessionId)).toEqual([
				A,
			]);
		}));

	it("filters the live tail by session", () =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			const fiber = yield* events
				.stream({ sessionId: A })
				.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild({ startImmediately: true }));
			const timestamp = yield* DateTime.now;
			yield* events.publish(EventList.TurnStarted, { timestamp, sessionId: B });
			yield* events.publish(EventList.TurnStarted, { timestamp, sessionId: A });

			const tail = yield* Fiber.join(fiber);
			expect(Array.from(tail).map((event) => (event.data as { readonly sessionId: string }).sessionId)).toEqual([A]);
		}));

	liveIt("buffers the live tail before replay and deduplicates overlapping durable events", () =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			const timestamp = yield* DateTime.now;
			yield* Effect.forEach(
				Array.from({ length: 101 }, (_, index) => index),
				(index) =>
					events.publish(EventList.TurnEnded, {
						timestamp,
						sessionId: A,
						messageId: SessionMessageSchema.ID.make(`message_${index}`),
					}),
				{ discard: true },
			);

			const replayStarted = yield* Deferred.make<void>();
			const continueReplay = yield* Deferred.make<void>();
			const tailStarted = yield* Deferred.make<void>();
			const continueTail = yield* Deferred.make<void>();
			const replayed = yield* Ref.make(0);
			const fiber = yield* events.stream({ sessionId: A, after: -1 }).pipe(
				Stream.tap(
					Effect.fnUntraced(function* (event) {
						const index = yield* Ref.getAndUpdate(replayed, (count) => count + 1);
						if (index === 0) {
							yield* Deferred.succeed(replayStarted, undefined);
							yield* Deferred.await(continueReplay);
							return;
						}
						if (
							event.type === EventList.LLMTextDelta.type &&
							(event.data as { readonly delta?: unknown }).delta === "during replay"
						) {
							yield* Deferred.succeed(tailStarted, undefined);
							yield* Deferred.await(continueTail);
						}
					}),
				),
				Stream.takeUntil(
					(event) =>
						event.type === EventList.LLMTextDelta.type &&
						(event.data as { readonly delta?: unknown }).delta === "sentinel",
				),
				Stream.runCollect,
				Effect.timeout("5 seconds"),
				Effect.forkChild({ startImmediately: true }),
			);

			yield* Deferred.await(replayStarted);
			yield* events.publish(EventList.LLMTextDelta, {
				timestamp,
				sessionId: A,
				messageId: SessionMessageSchema.ID.make("message_live"),
				partIndex: 0,
				delta: "during replay",
			});
			yield* events.publish(EventList.TurnEnded, {
				timestamp,
				sessionId: A,
				messageId: SessionMessageSchema.ID.make("message_overlap"),
			});
			yield* Deferred.succeed(continueReplay, undefined);
			yield* Deferred.await(tailStarted);
			yield* events.publish(EventList.TurnEnded, {
				timestamp,
				sessionId: A,
				messageId: SessionMessageSchema.ID.make("message_tail"),
			});
			yield* events.publish(EventList.LLMTextDelta, {
				timestamp,
				sessionId: A,
				messageId: SessionMessageSchema.ID.make("message_live"),
				partIndex: 0,
				delta: "sentinel",
			});
			yield* Deferred.succeed(continueTail, undefined);

			const collected = Array.from(yield* Fiber.join(fiber));
			const overlap = collected.filter(
				(event) =>
					event.type === EventList.TurnEnded.type &&
					(event.data as { readonly messageId?: unknown }).messageId === "message_overlap",
			);
			const tail = collected.filter(
				(event) =>
					event.type === EventList.TurnEnded.type &&
					(event.data as { readonly messageId?: unknown }).messageId === "message_tail",
			);
			const deltas = collected
				.filter((event) => event.type === EventList.LLMTextDelta.type)
				.map((event) => (event.data as { readonly delta: string }).delta);

			expect(collected).toHaveLength(105);
			expect(overlap).toHaveLength(1);
			expect(tail).toHaveLength(1);
			expect(deltas).toEqual(["during replay", "sentinel"]);
		}),
	);
});
