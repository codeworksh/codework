import { Cause, Context, Effect, Layer, Option, PubSub, Ref, Stream } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { EventRow } from "../db/schema.sql.ts";
// Uncomment with `decodeSerializedEvent` below — the manifest is what it looks
// stored types up in.
// import { Durable } from "./manifest.ts";
import { Schema } from "effect";
import { EventManifest } from "./manifest.ts";
import type { Data, Definition, ID, Payload } from "./schema.ts";
import { EventSchema } from "./schema.ts";

export type SerializedEvent = {
	readonly id: ID;
	readonly type: string;
	readonly seq: number;
	readonly aggregateId: string;
	readonly data: Record<string, unknown>;
};

export type Subscriber<D extends Definition = Definition> = (event: Payload<D>) => Effect.Effect<void>;
export type Unsubscribe = Effect.Effect<void>;

export class InvalidDurableEventError extends Schema.TaggedError<InvalidDurableEventError>()(
	"InvalidDurableEventError",
	{
		type: Schema.String,
		message: Schema.String,
	},
) {}

// TODO: uncomment when required!
// const decodeSerializedEvent = (event: SerializedEvent): Payload => {
//   const definition = Durable.get(event.type);
//   if (!definition?.durable) {
//     throw new Error(`unknown durable event type ${event.type}`);
//   }
//   return {
//     id: event.id,
//     type: definition.type,
//     durable: {
//       aggregateId: event.aggregateId,
//       seq: event.seq,
//       version: definition.durable.version,
//     },
//     data: Schema.decodeUnknownSync(definition.data)(event.data),
//   };
// };

/**
 * A durable read manifest: the definitions whose stored rows are in scope, keyed
 * by versioned type, plus the decoder those rows are decoded through. `schema`
 * is the tagged union of the same definitions, so it validates the whole
 * envelope (id/type/durable/data), not just the payload.
 */
export type Manifest<A> = {
	readonly definitions: ReadonlyMap<string, Definition>;
	readonly schema: Schema.Decoder<A, never>;
};

export type ReadAggregateInput<A> = {
	readonly aggregateId: string;
	/** Exclusive lower bound. Omitted reads from the first stored sequence (0). */
	readonly after?: number;
	readonly limit: number;
	readonly manifest: Manifest<A>;
};

export type ReadAggregateResult<A> = {
	readonly events: ReadonlyArray<A>;
	readonly hasMore: boolean;
};

export interface PublishOptions {
	/** Caller-supplied event ID. Publishing the same ID twice is a defect, not an upsert. */
	readonly id?: ID;
	/**
	 * Publish-time context — correlation, tracing — carried to projectors on the
	 * in-memory payload and deliberately not stored in the event row. A projector
	 * persists it into its own projection if it means something there; the log
	 * records what happened, not who asked. It therefore does not survive a
	 * durable reread or a rebuild, which `event.test.ts` pins explicitly.
	 */
	readonly metadata?: Record<string, string>;
}

export interface Interface {
	readonly latestSequence: (aggregateId: string) => Effect.Effect<number>;
	readonly readAggregate: <A>(input: ReadAggregateInput<A>) => Effect.Effect<ReadAggregateResult<A>>;
	/**
	 * Appends one event. Durable definitions are assigned the aggregate's next
	 * sequence, projected, and stored in a single transaction; the returned
	 * payload carries that sequence in `durable`.
	 */
	readonly publish: <D extends Definition>(
		definition: D,
		data: Data<D>,
		options?: PublishOptions,
	) => Effect.Effect<Payload<D>>;
	/**
	 * Registers a projector for one event type. Projectors run inside the commit
	 * transaction, so a failing projector rolls the event back with it.
	 */
	readonly project: <D extends Definition>(definition: D, projector: Subscriber<D>) => Effect.Effect<void>;
	/**
	 * Live stream of one event type.
	 *
	 * This is the only way to read a non-durable definition -- stream deltas and
	 * block boundaries. They never reach a projector: projectors run inside the
	 * commit, and a live event has no commit, so registering one for a live type
	 * compiles and silently never fires.
	 */
	readonly subscribe: <D extends Definition>(definition: D) => Stream.Stream<Payload<D>>;
	/** Every event, durable and live alike, in publish order. */
	readonly all: () => Stream.Stream<Payload>;
	/** Durable catch-up followed by the process-local event tail for one session.
	 * TODO(sanchitrk):
	 * revisite once's we implement durable streams, a common channel for IO output,
	 * chances are we wont't need this anymore?
	 */
	readonly stream: (input: { readonly sessionId: string; readonly after?: number }) => Stream.Stream<Payload>;
	/**
	 * Callback form of {@link all}, returning its own removal. A listener runs
	 * after the commit for a durable event, and its failures are logged rather
	 * than surfaced -- the event already happened, so a watcher cannot undo it.
	 */
	readonly listen: (listener: Subscriber) => Effect.Effect<Unsubscribe>;
	/**
	 * Moves an aggregate's head to at least `seq`, so the next published event
	 * lands above it. Two callers need this: a fork, reserving [0..seq] for
	 * copied entries, and any write that takes a position without going through
	 * an event -- otherwise the head still points below state that already
	 * exists, and the next event collides with it.
	 *
	 * A sequence is a version position, not a row count, so declaring an
	 * aggregate "already at version N" is legal. Never rewinds: a lower `seq`
	 * than the current head is a no-op.
	 */
	readonly advance: (aggregateId: string, seq: number) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/event/event/Service") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;

		const pubsub = {
			all: yield* PubSub.unbounded<Payload>(),
			typed: new Map<string, PubSub.PubSub<Payload>>(),
		};
		const projectors = new Map<string, Subscriber[]>();
		const listeners = new Array<Subscriber>();

		// Subscribers block on their pubsub, so releasing the layer without
		// shutting them down strands whoever is reading a stream from it.
		yield* Effect.addFinalizer(() =>
			Effect.gen(function* () {
				yield* PubSub.shutdown(pubsub.all);
				yield* Effect.forEach(pubsub.typed.values(), PubSub.shutdown, { discard: true });
			}),
		);

		const observe = (event: Payload, observer: (event: Payload) => Effect.Effect<void>) =>
			Effect.suspend(() => observer(event)).pipe(
				Effect.catchCauseIf(
					(cause) => !Cause.hasInterrupts(cause),
					(cause) => Effect.logError("Event listener failed", { eventID: event.id, eventType: event.type, cause }),
				),
			);

		function notify(event: Payload, isolateListeners: boolean) {
			return Effect.gen(function* () {
				yield* Effect.forEach(
					listeners,
					(listener) => (isolateListeners ? observe(event, listener) : listener(event)),
					{ discard: true },
				);
				const typed = pubsub.typed.get(event.type);
				if (typed) yield* PubSub.publish(typed, event);
				yield* PubSub.publish(pubsub.all, event);
			});
		}

		// aggregate_id is the primary key, so the first row is the only row.
		const findLatestSequence = SqlSchema.findOneOption({
			Request: Schema.String,
			Result: Schema.Struct({ seq: Schema.Int }),
			execute: (aggregateId) => sql`SELECT seq FROM event_sequence WHERE aggregate_id = ${aggregateId}`,
		});

		// -1 for an aggregate that has never been written, so that the first
		// sequence a publisher assigns (`latest + 1`) is 0.
		const latestSequence = Effect.fn("Event.latestSequence")(function* (aggregateId: string) {
			return yield* findLatestSequence(aggregateId).pipe(
				Effect.map(Option.match({ onNone: () => -1, onSome: (row) => row.seq })),
				Effect.orDie,
			);
		});

		// Type is filtered against the manifest so a row written by a build that
		// knew more event types is skipped rather than failing the whole page.
		const selectAggregateEvents = SqlSchema.findAll({
			Request: Schema.Struct({
				aggregateId: Schema.String,
				after: Schema.Int,
				types: Schema.Array(Schema.String),
				limit: Schema.Int,
			}),
			Result: EventRow,
			execute: ({ aggregateId, after, types, limit }) =>
				sql`
          SELECT * FROM event
          WHERE aggregate_id = ${aggregateId} AND seq > ${after} AND ${sql.in("type", types)}
          ORDER BY seq ASC
          LIMIT ${limit}
        `,
		});

		// Reads one page of an aggregate's durable history. One row past the page is
		// fetched so `hasMore` needs no second query; the extra row is dropped.
		const readAggregate = Effect.fn("Event.readAggregate")(function* <A>(input: ReadAggregateInput<A>) {
			const after = input.after ?? -1;
			const rows = yield* selectAggregateEvents({
				aggregateId: input.aggregateId,
				after,
				types: Array.from(input.manifest.definitions.keys()),
				limit: input.limit + 1,
			});
			const page = rows.slice(0, input.limit);
			const decode = Schema.decodeUnknownEffect(input.manifest.schema);
			// The `type` column stores the versioned type; the envelope carries the
			// bare type, so it is mapped back through the definition. A row that no
			// longer decodes is a broken store, not a recoverable read.
			const events = yield* Effect.forEach(page, (row) => {
				const definition = input.manifest.definitions.get(row.type);
				return decode({
					id: row.id,
					type: definition?.type ?? row.type,
					durable: {
						aggregateId: row.aggregateId,
						seq: row.seq,
						version: definition?.durable?.version,
					},
					data: row.data,
				});
			});
			return { events, hasMore: rows.length > input.limit };
		}, Effect.orDie);

		// Allocates an aggregate's next sequence in one statement: the row is
		// created at 0 or bumped by one, and the new value comes back. Deliberately
		// not a SELECT followed by an INSERT -- `SqlClient` begins DEFERRED, and a
		// read-then-write transaction can fail the lock upgrade with
		// SQLITE_BUSY_SNAPSHOT under WAL (see sandbox/store.ts). Writing first takes
		// the write lock on the transaction's first statement instead.
		const bumpSequence = SqlSchema.findOne({
			Request: Schema.String,
			Result: Schema.Struct({ seq: Schema.Int }),
			execute: (aggregateId) => sql`
        INSERT INTO event_sequence (aggregate_id, seq) VALUES (${aggregateId}, 0)
        ON CONFLICT(aggregate_id) DO UPDATE SET seq = event_sequence.seq + 1
        RETURNING seq
      `,
		});

		const findEventById = SqlSchema.findOneOption({
			Request: Schema.String,
			Result: Schema.Struct({ aggregateId: Schema.String, seq: Schema.Int }),
			execute: (id) => sql`SELECT aggregate_id, seq FROM event WHERE id = ${id}`,
		});

		const insertEvent = SqlSchema.void({
			Request: EventRow.insert,
			execute: (row) => sql`INSERT INTO event ${sql.insert(row)}`,
		});

		/**
		 * Assigns the sequence, runs the projectors, and stores the row as one unit.
		 * Projecting inside the transaction is the point: a projector that rejects
		 * the event (a lifecycle conflict, say) takes the event down with it, so the
		 * log and its views can never disagree.
		 */
		const commitDurableEvent = Effect.fn("Event.commitDurableEvent")(
			function* <D extends Definition>(definition: D, event: Payload<D>) {
				const durable = definition.durable;
				if (!durable) return undefined;
				const aggregateId = (event.data as Record<string, unknown>)[durable.aggregate];
				if (typeof aggregateId !== "string")
					return yield* Effect.die(
						new InvalidDurableEventError({
							type: event.type,
							message: `Expected string aggregate field ${durable.aggregate}`,
						}),
					);
				const encoded = (yield* Schema.encodeUnknownEffect(definition.data)(event.data)) as Record<string, unknown>;
				const committed = yield* sql.withTransaction(
					Effect.gen(function* () {
						const { seq } = yield* bumpSequence(aggregateId);
						const existing = yield* findEventById(event.id);
						if (Option.isSome(existing))
							return yield* Effect.die(
								new InvalidDurableEventError({
									type: event.type,
									message: `Event ${event.id} already exists at aggregate ${existing.value.aggregateId} sequence ${existing.value.seq}`,
								}),
							);
						const payload = {
							...event,
							durable: { aggregateId, seq, version: durable.version },
						} as Payload<D>;
						for (const projector of projectors.get(event.type) ?? []) yield* projector(payload as Payload);
						// The stored type carries the version; the in-memory payload does not.
						yield* insertEvent({
							id: event.id,
							aggregateId,
							seq,
							type: EventSchema.versionedType(definition.type, durable.version),
							data: encoded,
						});
						return payload;
					}),
				);
				return committed;
			},
			Effect.orDie,
			Effect.uninterruptible,
		);

		const publishEvent = Effect.fn("Event.publishEvent")(function* <D extends Definition>(
			definition: D,
			event: Payload<D>,
		) {
			if (definition.durable) {
				const committed = yield* commitDurableEvent(definition, event);
				// Durable listeners are isolated: the event is already committed, so a
				// throwing listener must not surface as a failed publish.
				if (committed) {
					yield* notify(committed as Payload, true);
					return committed;
				}
			}
			yield* notify(event as Payload, false);
			return event;
		});

		const publish = Effect.fn("Event.publish")(function* <D extends Definition>(
			definition: D,
			data: Data<D>,
			options?: PublishOptions,
		) {
			return yield* publishEvent(definition, {
				id: options?.id ?? EventSchema.ID.create(),
				...(options?.metadata ? { metadata: options.metadata } : {}),
				type: definition.type,
				data,
			} as Payload<D>);
		});

		// MAX, so this only ever moves the head forward. Lowering it would hand out
		// sequences that already exist.
		const advanceSequence = SqlSchema.void({
			Request: Schema.Struct({ aggregateId: Schema.String, seq: Schema.Int }),
			execute: ({ aggregateId, seq }) => sql`
        INSERT INTO event_sequence (aggregate_id, seq) VALUES (${aggregateId}, ${seq})
        ON CONFLICT(aggregate_id) DO UPDATE SET seq = MAX(event_sequence.seq, excluded.seq)
      `,
		});

		const advance = Effect.fn("Event.advance")(function* (aggregateId: string, seq: number) {
			yield* advanceSequence({ aggregateId, seq });
		}, Effect.orDie);

		const project = <D extends Definition>(definition: D, projector: Subscriber<D>): Effect.Effect<void> =>
			Effect.sync(() => {
				const list = projectors.get(definition.type) ?? [];
				list.push((event) => projector(event as Payload<D>));
				projectors.set(definition.type, list);
			});

		// One pubsub per type, created on first subscribe. A type nobody watches
		// costs nothing, and `notify` skips it.
		const getOrCreate = (definition: Definition) =>
			Effect.gen(function* () {
				const existing = pubsub.typed.get(definition.type);
				if (existing) return existing;
				const created = yield* PubSub.unbounded<Payload>();
				pubsub.typed.set(definition.type, created);
				return created;
			});

		const subscribe = <D extends Definition>(definition: D): Stream.Stream<Payload<D>> =>
			Stream.unwrap(getOrCreate(definition).pipe(Effect.map((created) => Stream.fromPubSub(created)))).pipe(
				Stream.map((event) => event as Payload<D>),
			);

		const streamAll = (): Stream.Stream<Payload> => Stream.fromPubSub(pubsub.all);

		const stream = (input: { readonly sessionId: string; readonly after?: number }): Stream.Stream<Payload> => {
			const forSession = (event: Payload) =>
				(event.data as { readonly sessionId?: unknown }).sessionId === input.sessionId;
			const after = input.after;
			if (after === undefined) return streamAll().pipe(Stream.filter(forSession));

			return Stream.unwrap(
				Effect.gen(function* () {
					// Subscribe before the first journal read. The subscription's unbounded
					// queue buffers durable and live-only events across the replay boundary.
					const subscription = yield* PubSub.subscribe(pubsub.all);
					const watermark = yield* Ref.make(after);
					const history = Stream.paginate(
						after,
						Effect.fn("Event.stream.history")(function* (after) {
							const page = yield* readAggregate({
								aggregateId: input.sessionId,
								after,
								limit: 100,
								manifest: EventManifest.Manifest,
							});
							const last = page.events.at(-1);
							const next =
								page.hasMore && last?.durable !== undefined
									? Option.some(last.durable.seq)
									: Option.none<number>();
							return [page.events, next] as const;
						}),
					).pipe(
						Stream.map((event) => event as Payload),
						Stream.tap((event) => {
							const seq = event.durable?.seq;
							return seq === undefined
								? Effect.void
								: Ref.update(watermark, (current) => Math.max(current, seq));
						}),
					);
					const tail = Stream.fromSubscription(subscription).pipe(
						Stream.filter(forSession),
						Stream.filterEffect((event) => {
							const seq = event.durable?.seq;
							return seq === undefined
								? Effect.succeed(true)
								: Ref.get(watermark).pipe(Effect.map((replayed) => seq > replayed));
						}),
					);
					return history.pipe(Stream.concat(tail));
				}),
			);
		};

		const listen = (listener: Subscriber): Effect.Effect<Unsubscribe> =>
			Effect.sync(() => {
				listeners.push(listener);
				return Effect.sync(() => {
					const index = listeners.indexOf(listener);
					if (index >= 0) listeners.splice(index, 1);
				});
			});

		return Service.of({
			latestSequence,
			readAggregate,
			publish,
			subscribe,
			all: streamAll,
			stream,
			listen,
			project,
			advance,
		});
	}),
);

export * as Event from "./event.ts";
