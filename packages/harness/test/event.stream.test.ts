import { DateTime, Effect, Fiber, Layer, Stream } from "effect";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { EventList } from "../src/event/list.ts";
import { SessionMessageSchema } from "../src/session/message/schema.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { testEffect } from "./utils/effect.ts";

const layer = Layer.provideMerge(Event.layer, Database.layer(":memory:"));
const { effect: it } = testEffect(layer);
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
});
