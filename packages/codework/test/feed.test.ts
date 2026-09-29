import { Event, EventList, EventSchema, Session } from "@codeworksh/harness/effect";
import { DateTime, Effect, Exit, Fiber, Option, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { EventFeed } from "../src/server/feed.ts";

/** Stands in for the event bus: one listener, published to on demand. */
const source = () => {
	let subscriber: Event.Subscriber | undefined;
	return {
		listen: (next: Event.Subscriber) =>
			Effect.sync(() => {
				subscriber = next;
				return Effect.sync(() => {
					if (subscriber === next) subscriber = undefined;
				});
			}),
		publish: (event: EventSchema.Payload) => Effect.suspend(() => subscriber?.(event) ?? Effect.void),
	};
};

const settled = (): EventSchema.Payload =>
	({
		id: EventSchema.ID.create(),
		type: EventList.ExecutionSucceeded.type,
		data: { sessionId: Session.SessionSchema.ID.create(), timestamp: DateTime.makeUnsafe(0) },
	}) as EventSchema.Payload;

describe("EventFeed", () => {
	it("fails the subscriber that exceeds its capacity without taking the feed down", () =>
		Effect.gen(function* () {
			const bus = source();
			const feed = yield* EventFeed.make(bus.listen, { capacity: 1 });
			const idle = yield* feed.subscribe;

			yield* bus.publish(settled());
			yield* bus.publish(settled());

			const exit = yield* idle.pipe(Stream.runCollect, Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isSuccess(exit)) return;
			expect(Option.getOrUndefined(Exit.findErrorOption(exit))).toBeInstanceOf(Event.SubscriptionOverflowError);

			// The lagging client is gone; the feed keeps serving everyone else.
			const next = yield* feed.subscribe;
			const received = yield* next.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
			yield* bus.publish(settled());
			expect(Array.from(yield* Fiber.join(received))).toHaveLength(1);
		}).pipe(Effect.scoped, Effect.runPromise));

	it("drops types outside the public registry before they consume capacity", () =>
		Effect.gen(function* () {
			const bus = source();
			const feed = yield* EventFeed.make(bus.listen, { capacity: 1 });
			const stream = yield* feed.subscribe;

			yield* bus.publish({ id: EventSchema.ID.create(), type: "plugin.test.custom", data: { value: "one" } });
			yield* bus.publish({ id: EventSchema.ID.create(), type: "plugin.test.custom", data: { value: "two" } });
			yield* bus.publish(settled());

			const [received] = Array.from(yield* stream.pipe(Stream.take(1), Stream.runCollect));
			expect(received?.type).toBe(EventList.ExecutionSucceeded.type);
		}).pipe(Effect.scoped, Effect.runPromise));

	it("disconnects current subscribers on an encoding failure and serves later ones", () =>
		Effect.gen(function* () {
			const bus = source();
			const feed = yield* EventFeed.make(bus.listen);
			const current = yield* feed.subscribe;
			const failed = yield* current.pipe(Stream.runCollect, Effect.exit, Effect.forkScoped);

			// A known public type whose payload cannot encode is a server bug, not a
			// client one -- it must not take the feed down with it.
			yield* bus.publish({ id: EventSchema.ID.create(), type: EventList.ExecutionSucceeded.type, data: {} });
			const exit = yield* Fiber.join(failed);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isSuccess(exit)) return;
			expect(Option.getOrUndefined(Exit.findErrorOption(exit))?._tag).toBe("EventEncodingError");

			const next = yield* feed.subscribe;
			const received = yield* next.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
			yield* bus.publish(settled());
			expect(Array.from(yield* Fiber.join(received))).toHaveLength(1);
		}).pipe(Effect.scoped, Effect.runPromise));
});
