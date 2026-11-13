import { Event, EventRegistry, EventSchema } from "@codeworksh/harness/effect";
import { Cause, Context, Effect, Layer, Option, Queue, type Scope, Stream } from "effect";
import * as Envelope from "./envelope.ts";
import { EncodingError, type EventEnvelope } from "./envelope.ts";

const SubscriberCapacity = 4096;

export type Error = Event.SubscriptionOverflowError | EncodingError;

/** What one client receives; checked before an event takes a place in its queue. */
export interface Filter {
	/** Only these types. */
	readonly types?: ReadonlySet<string>;
	/** Only events naming this thread. */
	readonly threadId?: string;
}

type Stream_ = Effect.Effect<Stream.Stream<EventEnvelope, Error>, never, Scope.Scope>;

export interface Interface {
	/** A live envelope stream for one client; releasing the scope unregisters it. */
	readonly subscribe: Stream_;
	/**
	 * {@link subscribe}, with a filter applied before an event takes a place in the queue. `replay` is
	 * read in the step that registers the client, and its events lead the stream.
	 */
	readonly filtered: (filter: Filter, replay?: () => ReadonlyArray<EventSchema.Payload>) => Stream_;
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
 * whoever connects next. Types outside the server's registry are dropped
 * before they can consume a client's capacity.
 */
export const make = Effect.fn("EventFeed.make")(function* (
	listen: (subscriber: Event.Subscriber) => Effect.Effect<Event.Unsubscribe>,
	options?: { readonly capacity?: number; readonly registry?: Envelope.Registry },
) {
	const capacity = options?.capacity ?? SubscriberCapacity;
	// Whatever this server knows how to describe, plugin registrations included.
	const registry = options?.registry ?? Envelope.Core;
	const subscribers = new Map<Queue.Queue<EventEnvelope, Error>, Filter>();

	const failAll = (error: Error) =>
		Effect.sync(() => {
			const current = Array.from(subscribers.keys());
			subscribers.clear();
			for (const subscriber of current) Queue.failCauseUnsafe(subscriber, Cause.fail(error));
		});

	const deliver = Effect.fnUntraced(function* (event: EventSchema.Payload) {
		if (subscribers.size === 0) return;
		// Dropped here rather than after the queue: a burst of events this server
		// cannot describe must not spend a client's capacity on its way to nowhere.
		if (registry(event.type) === undefined) return;
		const envelope = yield* Envelope.encode(event, registry);
		for (const [subscriber, filter] of subscribers) {
			if (!accepts(filter, envelope)) continue;
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

	const accepts = (filter: Filter, envelope: EventEnvelope) =>
		(filter.types === undefined || filter.types.has(envelope.type)) &&
		(filter.threadId === undefined || Envelope.ofThread(filter.threadId)(envelope));

	const filtered: Interface["filtered"] = (filter, replay = () => []) =>
		Effect.gen(function* () {
			const queue = yield* Effect.acquireRelease(Queue.dropping<EventEnvelope, Error>(capacity), (queue) =>
				Effect.sync(() => subscribers.delete(queue)).pipe(Effect.andThen(Queue.shutdown(queue))),
			);
			// Read and registered in one step: an event published after the snapshot is delivered live.
			const missed = yield* Effect.sync(() => {
				subscribers.set(queue, filter);
				return replay();
			});
			const replayed: Array<EventEnvelope> = [];
			for (const event of missed) {
				if (registry(event.type) === undefined) continue;
				const envelope = yield* Envelope.encode(event, registry).pipe(Effect.option);
				if (Option.isSome(envelope) && accepts(filter, envelope.value)) replayed.push(envelope.value);
			}
			return Stream.fromIterable(replayed).pipe(Stream.concat(Stream.fromQueue(queue)));
		});

	const unsubscribe = yield* listen(publish);
	yield* Effect.addFinalizer(() => unsubscribe);

	return Service.of({
		subscribe: filtered({}),
		filtered,
	});
});

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const events = yield* Event.Service;
		const registered = yield* EventRegistry.Service;
		return yield* make(events.listen, { registry: registered.get });
	}),
);
