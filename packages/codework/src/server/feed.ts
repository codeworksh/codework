import { Event, EventRegistry, EventSchema } from "@codeworksh/harness/effect";
import { Cause, Context, Effect, Layer, Queue, Scope, Stream } from "effect";
import { EncodingError, type EventEnvelope, Envelope } from "./envelope.ts";

export const SubscriberCapacity = 4096;

export type Error = Event.SubscriptionOverflowError | EncodingError;

export interface Interface {
	/** A live envelope stream for one client; releasing the scope unregisters it. */
	readonly subscribe: Effect.Effect<Stream.Stream<EventEnvelope, Error>, never, Scope.Scope>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/cli/server/feed/Service") {}

/**
 * Fan-out for `event.subscribe`. One listener on the event bus encodes each
 * event once and hands the same envelope to every client, rather than every
 * client re-encoding the same payload.
 *
 * Failure is per-cause, not per-feed: a client that cannot keep up fails alone
 * with its own overflow, while an event that cannot be encoded is a server bug
 * that disconnects everyone currently attached -- the feed stays usable for
 * whoever connects next. Types outside the public registry (plugin events,
 * §12) are dropped before they can consume a client's capacity.
 */
export const make = Effect.fn("EventFeed.make")(function* (
	listen: (subscriber: Event.Subscriber) => Effect.Effect<Event.Unsubscribe>,
	options?: { readonly capacity?: number; readonly registry?: Envelope.Registry },
) {
	const capacity = options?.capacity ?? SubscriberCapacity;
	// Whatever this server knows how to describe, plugin registrations included.
	const registry = options?.registry ?? Envelope.Core;
	const subscribers = new Set<Queue.Queue<EventEnvelope, Error>>();

	const failAll = (error: Error) =>
		Effect.sync(() => {
			const current = Array.from(subscribers);
			subscribers.clear();
			for (const subscriber of current) Queue.failCauseUnsafe(subscriber, Cause.fail(error));
		});

	const deliver = Effect.fnUntraced(function* (event: EventSchema.Payload) {
		if (subscribers.size === 0) return;
		// Dropped here rather than after the queue: a burst of events this server
		// cannot describe must not spend a client's capacity on its way to nowhere.
		if (registry(event.type) === undefined) return;
		const envelope = yield* Envelope.encode(event, registry);
		for (const subscriber of subscribers) {
			if (Queue.offerUnsafe(subscriber, envelope)) continue;
			subscribers.delete(subscriber);
			Queue.failCauseUnsafe(subscriber, Cause.fail(new Event.SubscriptionOverflowError({ capacity })));
		}
	});

	const publish = (event: EventSchema.Payload) =>
		deliver(event).pipe(
			Effect.catchTags({
				EventEncodingError: (error) =>
					Effect.logError("Failed to encode public event", { type: error.type, cause: error.cause }).pipe(
						Effect.andThen(failAll(error)),
					),
				// The registry guard in `deliver` already returned for unknown types.
				UnknownEventTypeError: Effect.die,
			}),
		);

	const unsubscribe = yield* listen(publish);
	yield* Effect.addFinalizer(() => unsubscribe);

	return Service.of({
		subscribe: Effect.acquireRelease(
			Queue.dropping<EventEnvelope, Error>(capacity).pipe(
				Effect.tap((queue) => Effect.sync(() => subscribers.add(queue))),
			),
			(queue) => Effect.sync(() => subscribers.delete(queue)).pipe(Effect.andThen(Queue.shutdown(queue))),
		).pipe(Effect.map(Stream.fromQueue)),
	});
});

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const events = yield* Event.Service;
		const registered = yield* EventRegistry.Service;
		return yield* make(events.listen, {
			registry: (type) => (type === Envelope.Connected.type ? Envelope.Connected : registered.get(type)),
		});
	}),
);

export * as EventFeed from "./feed.ts";
