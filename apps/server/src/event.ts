import { Clock, Context, Duration, Effect, Layer, Option, PubSub, Schema, Semaphore, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { Contract, type Event, type Publish, type Request, type Synced } from "./contract.ts";
import { Db } from "./db.ts";

export interface Interface {
	/**
	 * Appends an event and hands it to every live subscriber of its topic. An id already stored
	 * returns that event and appends nothing; an ephemeral event skips the log entirely.
	 */
	readonly publish: (input: Publish) => Effect.Effect<Event>;
	/** Publishes `input` and waits for its reply: the first event on its topic caused by it. */
	readonly request: (input: Request, timeout?: Duration.Input) => Effect.Effect<Event, Contract.EventTimeout>;
	readonly subscribe: (input: {
		readonly topics: ReadonlyArray<string>;
		readonly after?: number | undefined;
	}) => Stream.Stream<Event | Synced>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/server/event/Service") {}

const Rows = Schema.Array(
	Schema.Struct({
		...Contract.Event.fields,
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

		const publish = Effect.fn("Event.publish")(function* ({ ephemeral, ...input }: Publish) {
			const id = input.id ?? (yield* Effect.sync(() => crypto.randomUUID()));
			const created = yield* Clock.currentTimeMillis;
			const event: Event = { ...input, id, created };
			if (ephemeral === true) {
				yield* PubSub.publish(live, event);
				return event;
			}
			const text = yield* encodePayload(input.payload).pipe(Effect.orDie);
			return yield* lock.withPermit(
				Effect.gen(function* () {
					const stored = yield* byId(id);
					if (stored !== undefined) return stored;
					const rows = yield* sql<{ seq: number }>`
						INSERT INTO event ${sql.insert({
							id,
							topic: input.topic,
							source: input.source,
							cause: input.cause ?? null,
							payload: text,
							created,
						})} RETURNING seq
					`.pipe(Effect.orDie);
					const committed: Event = { ...event, seq: rows[0]!.seq };
					yield* PubSub.publish(live, committed);
					return committed;
				}),
			);
		});

		return Service.of({
			publish,

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
						orElse: () => Effect.fail(new Contract.EventTimeout({ id, topic: input.topic })),
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
						const past =
							after === undefined || after >= through || wanted.size === 0
								? []
								: yield* replay(topics, after, through);
						return Stream.fromIterable<Event | Synced>(past).pipe(
							Stream.concat(Stream.make(Contract.Synced.make({ seq: through }))),
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
