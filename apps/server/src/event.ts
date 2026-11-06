import {
	Clock,
	Context,
	Duration,
	Effect,
	Layer,
	Option,
	PubSub,
	Schema,
	Semaphore,
	Stream,
	SubscriptionRef,
} from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { WidgetEvent, type Event, type Publish, type Request, type Synced } from "@codeworksh/widget/event";
import { Db } from "./db.ts";

export interface Interface {
	/**
	 * Appends an event and hands it to every live subscriber of its topic. An id already stored
	 * returns that event and appends nothing; an ephemeral event skips the log entirely.
	 */
	readonly publish: (input: Publish) => Effect.Effect<Event>;
	/** Publishes `input` and waits for its reply: the first event on its topic caused by it. */
	readonly request: (input: Request, timeout?: Duration.Input) => Effect.Effect<Event, WidgetEvent.EventTimeout>;
	readonly subscribe: (input: {
		readonly topics: ReadonlyArray<string>;
		readonly after?: number | undefined;
	}) => Stream.Stream<Event | Synced>;
	/** How many subscriptions follow `topic`: the current count, then each change. */
	readonly watchers: (topic: string) => Stream.Stream<number>;
	/**
	 * Runs `body` in one database transaction; what it appends is stored in that transaction and
	 * handed to live subscribers once it commits, so a row and the event announcing it land together.
	 */
	readonly transact: <A, E, R>(
		body: (append: (input: Publish) => Effect.Effect<void>) => Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | SqlError.SqlError, R>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/server/event/Service") {}

const Rows = Schema.Array(
	Schema.Struct({
		...WidgetEvent.Event.fields,
		seq: Schema.Int,
		cause: Schema.NullOr(Schema.String),
		payload: Db.JsonText,
	}),
);
const decodeRows = Schema.decodeUnknownEffect(Rows);
const encodePayload = Schema.encodeEffect(Db.JsonText);

const toEvent = ({ cause, ...row }: (typeof Rows.Type)[number]): Event => ({
	...row,
	...(cause === null ? {} : { cause }),
});

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const live = yield* PubSub.unbounded<Event>();
		// Insert and broadcast as one step, so live subscribers see events in seq order.
		const lock = yield* Semaphore.make(1);
		const watching = yield* SubscriptionRef.make<ReadonlyMap<string, number>>(new Map());
		const watch = (topics: ReadonlySet<string>, by: 1 | -1) =>
			SubscriptionRef.update(watching, (counts) => {
				const next = new Map(counts);
				for (const topic of topics) {
					const count = (next.get(topic) ?? 0) + by;
					if (count > 0) next.set(topic, count);
					else next.delete(topic);
				}
				return next;
			});

		const head = sql<{ seq: number | null }>`SELECT MAX(seq) AS seq FROM event`.pipe(
			Effect.map((rows) => rows[0]?.seq ?? 0),
			Effect.orDie,
		);

		const select = (query: Effect.Effect<ReadonlyArray<unknown>, unknown>) =>
			query.pipe(
				Effect.flatMap(decodeRows),
				Effect.map((rows) => rows.map(toEvent)),
				Effect.orDie,
			);

		const byId = (id: string) =>
			select(sql`SELECT seq, id, topic, source, cause, payload, created FROM event WHERE id = ${id}`).pipe(
				Effect.map((rows) => rows[0]),
			);

		const replyTo = (topic: string, id: string) =>
			select(sql`
				SELECT seq, id, topic, source, cause, payload, created FROM event
				WHERE cause = ${id} AND topic = ${topic} ORDER BY seq LIMIT 1
			`).pipe(Effect.map((rows) => rows[0]));

		const replay = (topics: ReadonlyArray<string>, after: number, through: number) =>
			select(sql`
				SELECT seq, id, topic, source, cause, payload, created FROM event
				WHERE seq > ${after} AND seq <= ${through} AND topic IN ${sql.in(topics)}
				ORDER BY seq
			`);

		const prepare = Effect.fnUntraced(function* ({ ephemeral, ...input }: Publish) {
			const id = input.id ?? (yield* Effect.sync(() => crypto.randomUUID()));
			const event: Event = { ...input, id, created: yield* Clock.currentTimeMillis };
			return { event, ephemeral: ephemeral === true };
		});

		// Run under `lock`: the seq it takes is broadcast before any later one.
		const insert = (event: Event) =>
			Effect.gen(function* () {
				const text = yield* encodePayload(event.payload).pipe(Effect.orDie);
				const rows = yield* sql<{ seq: number }>`
					INSERT INTO event ${sql.insert({
						id: event.id,
						topic: event.topic,
						source: event.source,
						cause: event.cause ?? null,
						payload: text,
						created: event.created,
					})} RETURNING seq
				`.pipe(Effect.orDie);
				return { ...event, seq: rows[0]!.seq } satisfies Event;
			});

		const publish = Effect.fn("Event.publish")(function* (input: Publish) {
			const { event, ephemeral } = yield* prepare(input);
			if (ephemeral) {
				yield* PubSub.publish(live, event);
				return event;
			}
			return yield* lock.withPermit(
				Effect.gen(function* () {
					const stored = yield* byId(event.id);
					if (stored !== undefined) return stored;
					const committed = yield* insert(event);
					yield* PubSub.publish(live, committed);
					return committed;
				}),
			);
		});

		// The lock is taken before the transaction, as `publish` takes it before the connection: the
		// other order would deadlock against a publish waiting for the connection.
		const transact: Interface["transact"] = (body) =>
			lock.withPermit(
				Effect.gen(function* () {
					const pending: Array<Event> = [];
					const result = yield* sql.withTransaction(
						body((input) =>
							Effect.gen(function* () {
								const { event, ephemeral } = yield* prepare(input);
								pending.push(ephemeral ? event : yield* insert(event));
							}),
						),
					);
					yield* PubSub.publishAll(live, pending);
					return result;
				}),
			);

		return Service.of({
			publish,
			transact,
			watchers: (topic) =>
				SubscriptionRef.changes(watching).pipe(
					Stream.map((counts) => counts.get(topic) ?? 0),
					Stream.changes,
				),

			request: Effect.fn("Event.request")(function* (input, timeout = "30 seconds") {
				const id = input.id ?? (yield* Effect.sync(() => crypto.randomUUID()));
				const isReply = (event: Event) => event.cause === id && event.topic === input.topic;
				return yield* Effect.scoped(
					Effect.gen(function* () {
						// Listening before publishing: a handler replying at once cannot slip past.
						const subscription = yield* PubSub.subscribe(live);
						yield* publish({ ...input, id });
						const stored = yield* replyTo(input.topic, id);
						if (stored !== undefined) return stored;
						return yield* Stream.fromSubscription(subscription).pipe(
							Stream.filter(isReply),
							Stream.runHead,
							Effect.map(Option.getOrThrow),
						);
					}),
				).pipe(
					Effect.timeoutOrElse({
						duration: timeout,
						orElse: () => Effect.fail(new WidgetEvent.EventTimeout({ id, topic: input.topic })),
					}),
				);
			}),

			subscribe: ({ topics, after }) =>
				Stream.unwrap(
					Effect.gen(function* () {
						// Subscribe before reading the head: an event committed in between is then both
						// replayed and live, and the live copy is dropped by seq; none can fall between.
						const subscription = yield* PubSub.subscribe(live);
						const through = yield* head;
						const wanted = new Set(topics);
						// Counted for the stream's lifetime, so a client that disconnects stops counting.
						yield* Effect.acquireRelease(watch(wanted, 1), () => watch(wanted, -1));
						const past =
							after === undefined || after >= through || wanted.size === 0
								? []
								: yield* replay(topics, after, through);
						return Stream.fromIterable<Event | Synced>(past).pipe(
							Stream.concat(Stream.make(WidgetEvent.Synced.make({ seq: through }))),
							Stream.concat(
								Stream.fromSubscription(subscription).pipe(
									Stream.filter(
										(event) => wanted.has(event.topic) && (event.seq === undefined || event.seq > through),
									),
								),
							),
						);
					}),
				),
		});
	}),
);

export * as Event from "./event.ts";
