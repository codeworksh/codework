import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { EventList } from "../src/event/list.ts";
import { SessionMessageSchema } from "../src/session/message/schema.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { testEffect } from "./utils/effect.ts";

const { live: it } = testEffect(Layer.provideMerge(Event.layer, Database.layer(":memory:")));
const sessionId = SessionSchema.ID.make("session_a");
const publish = (events: Event.Interface, index: number) =>
	Effect.gen(function* () {
		const timestamp = yield* DateTime.now;
		return yield* events.publish(EventList.TurnEnded, {
			timestamp,
			sessionId,
			messageId: SessionMessageSchema.ID.make(`message_${index}`),
		});
	});

describe("Event.subscribe", () => {
	it("fans out future durable and ephemeral events with type filtering and no replay", () =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			yield* publish(events, 0);
			const all = yield* events
				.subscribe()
				.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild({ startImmediately: true }));
			const typed = yield* events
				.subscribe(EventList.TurnEnded)
				.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild({ startImmediately: true }));
			const timestamp = yield* DateTime.now;
			const ephemeral = yield* events.publish(EventList.LLMTextDelta, {
				timestamp,
				sessionId,
				messageId: SessionMessageSchema.ID.make("message_live"),
				partIndex: 0,
				delta: "hello",
			});
			const durable = yield* publish(events, 1);
			expect(Array.from(yield* Fiber.join(all))).toEqual([ephemeral, durable]);
			expect(Array.from(yield* Fiber.join(typed))).toEqual([durable]);
		}).pipe(Effect.timeout("5 seconds")));

	it("fails only the overflowing subscriber without blocking publishers", () =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			const paused = yield* Deferred.make<void>();
			const resume = yield* Deferred.make<void>();
			const slow = yield* events.subscribe({ capacity: 1 }).pipe(
				Stream.tap(() => Deferred.succeed(paused, undefined).pipe(Effect.andThen(Deferred.await(resume)))),
				Stream.runDrain,
				Effect.exit,
				Effect.forkChild({ startImmediately: true }),
			);
			const healthy = yield* events
				.subscribe()
				.pipe(Stream.take(3), Stream.runCollect, Effect.forkChild({ startImmediately: true }));
			yield* publish(events, 0);
			yield* Deferred.await(paused);
			yield* publish(events, 1);
			yield* publish(events, 2);
			expect(Array.from(yield* Fiber.join(healthy))).toHaveLength(3);
			yield* Deferred.succeed(resume, undefined);
			const exit = yield* Fiber.join(slow);
			expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("SubscriptionOverflowError");
		}).pipe(Effect.timeout("5 seconds")));

	it("releases a cancelled subscription while remaining subscribers keep receiving", () =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			const leaving = yield* events
				.subscribe({ capacity: 1 })
				.pipe(Stream.runDrain, Effect.forkChild({ startImmediately: true }));
			yield* Fiber.interrupt(leaving);
			const staying = yield* events
				.subscribe(EventList.TurnEnded, { capacity: 2 })
				.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild({ startImmediately: true }));
			const first = yield* publish(events, 0);
			const second = yield* publish(events, 1);
			expect(Array.from(yield* Fiber.join(staying))).toEqual([first, second]);
		}).pipe(Effect.timeout("5 seconds")));
});
