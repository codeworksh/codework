import { Cause, Context, Effect, Layer, Option, PubSub, Queue, Ref, Stream } from "effect";
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

/**
 * Marks completion of the initial journal read through the captured sequence.
 * Emitted once per `log` stream; omitted `seq` means the head was -1.
 * This is a replay boundary, not an acknowledgment of consumer processing.
 */
export type Synced = {
	readonly type: "log.synced";
	readonly aggregateId: string;
	readonly seq?: number;
};

/** Either a stored event or the watermark marker that ends `log`'s catch-up. */
export type LogItem = Payload | Synced;

export const isSynced = (item: LogItem): item is Synced => item.type === "log.synced";

export type LogInput = {
	readonly aggregateId: string;
	/** Exclusive lower bound. Omitted reads from the first stored sequence (0). */
	readonly after?: number;
	/** Keep the stream open past the marker, appending events as they commit. */
	readonly follow?: boolean;
	/**
	 * Which stored types this read understands, keyed by versioned type -- build it
	 * with `EventSchema.durable([...definitions])`. Rows of any other type are
	 * skipped, exactly as an unknown type from a newer build is. Defaults to the
	 * application manifest, so a kernel reader passes nothing.
	 *
	 * A caller owning durable definitions outside `EventList` supplies them here,
	 * including the older versions it still decodes; the default does not know them
	 * and would filter every row.
	 *
	 * Only the definitions are needed, not a decoder: `log` decodes each row's
	 * `data` with its own definition and builds the envelope itself, so what it
	 * emits is always a well-formed {@link Payload}.
	 */
	readonly definitions?: ReadonlyMap<string, Definition>;
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

export class SubscriptionOverflowError extends Schema.TaggedError<SubscriptionOverflowError>()(
	"SubscriptionOverflowError",
	{ capacity: Schema.Int },
) {}

export interface SubscribeOptions {
	/** Maximum queued events per consumer. Defaults to 4096; must be a positive integer. */
	readonly capacity?: number;
}

export interface Subscribe {
	(options?: SubscribeOptions): Stream.Stream<Payload, SubscriptionOverflowError>;
	<D extends Definition>(
		definition: D,
		options?: SubscribeOptions,
	): Stream.Stream<Payload<D>, SubscriptionOverflowError>;
}

export interface Interface {
	/** Current sequence head, or -1 if absent. A version position, not a row count. */
	readonly latestSequence: (aggregateId: string) => Effect.Effect<number>;
	/**
	 * Reads one page of stored events in sequence order, filtered and decoded by
	 * the supplied manifest. `after` is exclusive; `hasMore` indicates another
	 * matching page. Does not follow new commits or emit a sync marker.
	 */
	readonly readAggregate: <A>(input: ReadAggregateInput<A>) => Effect.Effect<ReadAggregateResult<A>>;
	/**
	 * Reads one aggregate's stored events after the exclusive `after` cursor in
	 * sequence order, decoded through `input.definitions` -- the application
	 * manifest unless the caller owns durable types outside `EventList`. Types the
	 * definitions do not name are skipped. Emits a {@link Synced} marker after reading
	 * through the captured head.
	 *
	 * Completes after the marker unless `follow` is true. Following rereads storage
	 * when this service instance commits an event; writes through other instances
	 * do not wake it. Ephemeral events are never included.
	 */
	readonly log: (input: LogInput) => Stream.Stream<LogItem>;
	/**
	 * Publishes one event and returns its payload. Durable events receive an
	 * aggregate sequence and commit with their projector changes in one transaction,
	 * then wake log followers before notifying live consumers. Ephemeral events
	 * only notify live consumers and have no stored row or durable sequence.
	 */
	readonly publish: <D extends Definition>(
		definition: D,
		data: Data<D>,
		options?: PublishOptions,
	) => Effect.Effect<Payload<D>>;
	/**
	 * Registers a callback for future durable commits of one type. Runs inside
	 * the transaction, so failure rolls back the event and transactional changes.
	 * Does not replay history. Registering an ephemeral type never invokes it.
	 */
	readonly project: <D extends Definition>(definition: D, projector: Subscriber<D>) => Effect.Effect<void>;
	/**
	 * Future durable and ephemeral events from this instance, optionally filtered
	 * by definition. Each consumer has a bounded queue; overflow fails only that
	 * subscription without blocking publishers. Subscribes when consumed, with no
	 * replay. Concurrent notification order may differ from durable sequence order;
	 * use `log` for ordered recovery. Missed ephemeral events cannot be recovered.
	 */
	readonly subscribe: Subscribe;
	/**
	 * Registers a live callback across types and aggregates; returns an effect to
	 * remove it. Publishers await callbacks before notifying stream subscribers.
	 * Keep callbacks short, such as nonblocking queue insertion; perform network IO
	 * and slow processing in a separate consumer.
	 * Durable callbacks run after commit: non-interruption failures are logged,
	 * while interruption propagates. Ephemeral callback failures propagate.
	 */
	readonly listen: (listener: Subscriber) => Effect.Effect<Unsubscribe>;
	/**
	 * Moves the sequence head to at least `seq` without inserting an event, running
	 * projectors, or waking followers. Used to reserve an inherited prefix on a
	 * fork. The next durable event receives a higher sequence; never rewinds.
	 */
	readonly advance: (aggregateId: string, seq: number) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/event/event/Service") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;

		const pubsub = {
			// Per-aggregate doorbells for `log`. A wake carries no payload -- the
			// follower rereads the table -- so sliding(1) is enough: a coalesced
			// wake loses nothing, and a slow follower never holds up a publish.
			durable: new Map<string, Set<PubSub.PubSub<void>>>(),
		};
		const subscriptions = new Set<{
			readonly type: string | undefined;
			readonly capacity: number;
			readonly queue: Queue.Queue<Payload, SubscriptionOverflowError>;
		}>();
		const projectors = new Map<string, Subscriber[]>();
		const listeners = new Array<Subscriber>();

		// Subscribers block on their pubsub, so releasing the layer without
		// shutting them down strands whoever is reading a stream from it.
		yield* Effect.addFinalizer(() =>
			Effect.gen(function* () {
				yield* Effect.forEach(subscriptions, (subscriber) => Queue.shutdown(subscriber.queue), { discard: true });
				subscriptions.clear();
				yield* Effect.forEach(
					Array.from(pubsub.durable.values(), (wakes) => Array.from(wakes)).flat(),
					PubSub.shutdown,
					{ discard: true },
				);
			}),
		);

		const observe = (event: Payload, observer: (event: Payload) => Effect.Effect<void>) =>
			Effect.suspend(() => observer(event)).pipe(
				Effect.catchCauseIf(
					(cause) => !Cause.hasInterrupts(cause),
					(cause) => Effect.logError("Event listener failed", { eventID: event.id, eventType: event.type, cause }),
				),
			);

		// Snapshotted: a follower's scope can close on another fiber while this
		// iterates, and publishing into a shut-down wake it already left is a no-op.
		const wakeFollowers = (aggregateId: string) =>
			Effect.forEach(Array.from(pubsub.durable.get(aggregateId) ?? []), (wake) => PubSub.publish(wake, undefined), {
				discard: true,
			});

		function notify(event: Payload, isolateListeners: boolean) {
			return Effect.gen(function* () {
				yield* Effect.forEach(
					listeners,
					(listener) => (isolateListeners ? observe(event, listener) : listener(event)),
					{ discard: true },
				);
				yield* Effect.sync(() => {
					for (const subscriber of subscriptions) {
						if (subscriber.type !== undefined && subscriber.type !== event.type) continue;
						if (Queue.offerUnsafe(subscriber.queue, event)) continue;
						subscriptions.delete(subscriber);
						Queue.failCauseUnsafe(
							subscriber.queue,
							Cause.fail(new SubscriptionOverflowError({ capacity: subscriber.capacity })),
						);
					}
				});
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
				through: Schema.Int,
				types: Schema.Array(Schema.String),
				limit: Schema.Int,
			}),
			Result: EventRow,
			execute: ({ aggregateId, after, through, types, limit }) =>
				sql`
          SELECT * FROM event
          WHERE aggregate_id = ${aggregateId} AND seq > ${after} AND seq <= ${through} AND ${sql.in("type", types)}
          ORDER BY seq ASC
          LIMIT ${limit}
        `,
		});

		// The `type` column stores the versioned type; the envelope carries the
		// bare type, so it is mapped back through the definition. A row that no
		// longer decodes is a broken store, not a recoverable read.
		const decodeRows = <A>(rows: ReadonlyArray<EventRow>, manifest: Manifest<A>) => {
			const decode = Schema.decodeUnknownEffect(manifest.schema);
			return Effect.forEach(rows, (row) => {
				const definition = manifest.definitions.get(row.type);
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
		};

		// An unbounded read: `seq` is a signed 32-bit column, so this is above any
		// sequence the store can hold.
		const UNBOUNDED = Number.MAX_SAFE_INTEGER;
		// Rows per page while walking an aggregate. Large enough that a long session
		// replays in a handful of queries, small enough to stay off the heap.
		const PAGE_SIZE = 128;

		// Reads one page of an aggregate's durable history. One row past the page is
		// fetched so `hasMore` needs no second query; the extra row is dropped.
		const readAggregate = Effect.fn("Event.readAggregate")(function* <A>(input: ReadAggregateInput<A>) {
			const rows = yield* selectAggregateEvents({
				aggregateId: input.aggregateId,
				after: input.after ?? -1,
				through: UNBOUNDED,
				types: Array.from(input.manifest.definitions.keys()),
				limit: input.limit + 1,
			});
			const page = rows.slice(0, input.limit);
			const events = yield* decodeRows(page, input.manifest);
			return { events, hasMore: rows.length > input.limit };
		}, Effect.orDie);

		/**
		 * One stored row to a payload, decoding `data` with its own definition and
		 * building the envelope from the row. Deliberately not a decode of the whole
		 * envelope through a union: `log` promises {@link Payload}, so `id`, `type`
		 * and `durable` are the kernel's to construct, never a caller-supplied
		 * decoder's to reshape or drop.
		 */
		const decodeLogRow = Effect.fn("Event.decodeLogRow")(function* (
			row: EventRow,
			definitions: ReadonlyMap<string, Definition>,
		) {
			// The SQL filter is built from these same keys, so a row here always matches.
			const definition = definitions.get(row.type)!;
			// The envelope's version is the stored row's, read back off its definition; a default
			// would label the row with a version nothing wrote. Callers filter non-durable
			// definitions out before this, so the guard is a backstop, not a code path.
			if (definition.durable === undefined)
				return yield* Effect.die(
					new InvalidDurableEventError({
						type: definition.type,
						message: `Unknown durable event type ${definition.type}`,
					}),
				);
			const data = yield* Schema.decodeEffect(definition.data as Schema.Codec<unknown, unknown>)(row.data);
			return {
				id: row.id,
				type: definition.type,
				durable: { aggregateId: row.aggregateId, seq: row.seq, version: definition.durable.version },
				data,
			} as Payload;
		});

		// The same read as `readAggregate`, bounded above and paged for `log`. The
		// manifest is a parameter rather than the process-wide one: a reader owning
		// durable types outside `EventList` supplies its own, and the filter would
		// otherwise drop every one of its rows.
		const readPage = Effect.fn("Event.readPage")(function* (input: {
			readonly aggregateId: string;
			readonly after: number;
			readonly through: number;
			readonly definitions: ReadonlyMap<string, Definition>;
		}) {
			const rows = yield* selectAggregateEvents({
				aggregateId: input.aggregateId,
				after: input.after,
				through: input.through,
				types: Array.from(input.definitions.keys()),
				limit: PAGE_SIZE + 1,
			});
			const page = rows.slice(0, PAGE_SIZE);
			// Skip a type the manifest does not carry as durable rather than failing the read: the
			// aggregate may hold rows this process cannot decode. `seq` below comes off the raw
			// tail, so cursors advance across the gap.
			const decodable = page.filter((row) => input.definitions.get(row.type)?.durable !== undefined);
			const events = yield* Effect.forEach(decodable, (row) => decodeLogRow(row, input.definitions));
			// `seq` is the stored row's, not one read back off a decoded value: the
			// window advances on what the table actually holds.
			return { events, hasMore: rows.length > PAGE_SIZE, seq: page.at(-1)?.seq };
		}, Effect.orDie);

		/** One catch-up pass over (`from`, `through`], paged, oldest first. */
		const readAggregateStream = (input: {
			readonly aggregateId: string;
			readonly from: number;
			readonly through: number;
			readonly definitions: ReadonlyMap<string, Definition>;
		}): Stream.Stream<Payload> =>
			Stream.paginate(
				input.from,
				Effect.fn("Event.readAggregateStream.page")(function* (after: number) {
					const page = yield* readPage({
						aggregateId: input.aggregateId,
						after,
						through: input.through,
						definitions: input.definitions,
					});
					const next = page.hasMore && page.seq !== undefined ? Option.some(page.seq) : Option.none<number>();
					return [page.events, next] as const;
				}),
			);

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
				// Keep the post-commit wake uninterruptible too: cancellation must not
				// strand a stored row while followers wait for their next notification.
				yield* wakeFollowers(aggregateId);
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

		function subscribe(options?: SubscribeOptions): Stream.Stream<Payload, SubscriptionOverflowError>;
		function subscribe<D extends Definition>(
			definition: D,
			options?: SubscribeOptions,
		): Stream.Stream<Payload<D>, SubscriptionOverflowError>;
		function subscribe(
			input?: Definition | SubscribeOptions,
			options?: SubscribeOptions,
		): Stream.Stream<Payload, SubscriptionOverflowError> {
			const definition = input && "type" in input ? input : undefined;
			const capacity = (definition ? options : (input as SubscribeOptions | undefined))?.capacity ?? 4096;
			return Stream.unwrap(
				Effect.gen(function* () {
					if (!Number.isSafeInteger(capacity) || capacity <= 0)
						return yield* Effect.die(new RangeError("Subscription capacity must be a positive integer"));
					const queue = yield* Queue.dropping<Payload, SubscriptionOverflowError>(capacity);
					const subscriber = { type: definition?.type, capacity, queue };
					yield* Effect.acquireRelease(
						Effect.sync(() => subscriptions.add(subscriber)),
						() => Effect.sync(() => subscriptions.delete(subscriber)).pipe(Effect.andThen(Queue.shutdown(queue))),
					);
					return Stream.fromQueue(queue);
				}),
			);
		}

		/**
		 * Registers a doorbell for one aggregate, removed with the caller's scope.
		 * Subscribing before publishing it means the follower cannot miss a wake it
		 * is registered for.
		 */
		const subscribeWake = (aggregateId: string) =>
			Effect.gen(function* () {
				const wake = yield* PubSub.sliding<void>(1);
				const subscription = yield* PubSub.subscribe(wake);
				yield* Effect.acquireRelease(
					Effect.sync(() => {
						const wakes = pubsub.durable.get(aggregateId) ?? new Set<PubSub.PubSub<void>>();
						wakes.add(wake);
						pubsub.durable.set(aggregateId, wakes);
					}),
					() =>
						Effect.sync(() => {
							const wakes = pubsub.durable.get(aggregateId);
							wakes?.delete(wake);
							if (wakes?.size === 0) pubsub.durable.delete(aggregateId);
						}).pipe(Effect.andThen(PubSub.shutdown(wake))),
				);
				return subscription;
			});

		const log = (input: LogInput): Stream.Stream<LogItem> =>
			Stream.unwrap(
				Effect.gen(function* () {
					const definitions = input.definitions ?? EventManifest.Manifest.definitions;
					// The cursor outlives a single catch-up: each wake resumes from the
					// last sequence actually emitted, not from where the pass began.
					const cursor = yield* Ref.make(input.after ?? -1);
					const catchUp = (through: number): Stream.Stream<Payload> =>
						Stream.unwrap(
							Ref.get(cursor).pipe(
								Effect.map((from) =>
									readAggregateStream({ aggregateId: input.aggregateId, from, through, definitions }),
								),
							),
						).pipe(
							// `durable` is built by `decodeLogRow`, never by a caller's decoder,
							// so the sequence here is always the stored one.
							Stream.tap((event) =>
								event.durable === undefined ? Effect.void : Ref.set(cursor, event.durable.seq),
							),
							// A finished pass read the whole window, so the cursor belongs at
							// its bound rather than at the last row that happened to be in it.
							// Without this, a head standing above the rows -- `advance` on a
							// fork, or types this build cannot decode -- would leave the live
							// filter permanently open and reread nothing on every wake. Only
							// on completion: a pass cut short mid-window must resume from the
							// last event actually emitted.
							Stream.onEnd(Ref.update(cursor, (seq) => Math.max(seq, through))),
						);
					// Registering the doorbell before reading the head is what closes the
					// gap: a commit landing during catch-up is either inside the window
					// pinned below or waiting as a wake once the marker is out.
					const wakes = input.follow ? yield* subscribeWake(input.aggregateId) : undefined;
					// Reading the head, and every reread below, can never land inside a
					// publisher's open transaction: the client holds one connection behind
					// a Semaphore(1), and `withTransaction` keeps that permit until it
					// commits. So a follower never sees a bumped sequence whose row is not
					// there yet, and never emits an event a failing projector rolls back.
					// A connection pool would take that guarantee away and need its own
					// per-aggregate lock -- what OpenCode's KeyedMutex is doing.
					const head = yield* latestSequence(input.aggregateId);
					const marker: Synced = {
						type: "log.synced",
						aggregateId: input.aggregateId,
						...(head >= 0 ? { seq: head } : {}),
					};
					const replay = catchUp(head).pipe(Stream.concat(Stream.make(marker)));
					if (!wakes) return replay;
					const live = Stream.fromSubscription(wakes).pipe(
						Stream.mapEffect(() => latestSequence(input.aggregateId)),
						// A wake coalesced with one already drained, or one for rows this
						// build cannot decode, leaves the head where the cursor is.
						Stream.filterEffect((target) => Ref.get(cursor).pipe(Effect.map((seq) => target > seq))),
						Stream.flatMap((target) => catchUp(target)),
					);
					return replay.pipe(Stream.concat(live));
				}),
			);

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
			log,
			publish,
			subscribe,
			listen,
			project,
			advance,
		});
	}),
);

export * as Event from "./event.ts";
