import { Clock, Context, Effect, Layer, PubSub, Schema, Semaphore, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { Contract, type Event, type Synced } from "./contract.ts";
import { Db } from "./db.ts";

export interface Interface {
	/** Appends an event and hands it to every live subscriber of its topic. */
	readonly publish: (input: {
		readonly topic: string;
		readonly source: string;
		readonly payload: Schema.Json;
	}) => Effect.Effect<Event>;
	readonly subscribe: (input: {
		readonly topics: ReadonlyArray<string>;
		readonly after?: number | undefined;
	}) => Stream.Stream<Event | Synced>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/server/event/Service") {}

const Rows = Schema.Array(Schema.Struct({ ...Contract.Event.fields, payload: Db.JsonText }));
const decodeRows = Schema.decodeUnknownEffect(Rows);
const encodePayload = Schema.encodeEffect(Db.JsonText);

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

		const replay = (topics: ReadonlyArray<string>, after: number, through: number) =>
			sql`
				SELECT seq, topic, source, payload, created FROM event
				WHERE seq > ${after} AND seq <= ${through} AND topic IN ${sql.in(topics)}
				ORDER BY seq
			`.pipe(Effect.flatMap(decodeRows), Effect.orDie);

		return Service.of({
			publish: Effect.fn("Event.publish")(function* ({ topic, source, payload }) {
				const text = yield* encodePayload(payload).pipe(Effect.orDie);
				return yield* lock.withPermit(
					Effect.gen(function* () {
						const created = yield* Clock.currentTimeMillis;
						const rows = yield* sql<{ seq: number }>`
							INSERT INTO event ${sql.insert({ topic, source, payload: text, created })} RETURNING seq
						`.pipe(Effect.orDie);
						const event: Event = { seq: rows[0]!.seq, topic, source, payload, created };
						yield* PubSub.publish(live, event);
						return event;
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
									Stream.filter((event) => event.seq > through && wanted.has(event.topic)),
								),
							),
						);
					}),
				),
		});
	}),
);

export * as Event from "./event.ts";
