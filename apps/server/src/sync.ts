import { Codework as Client } from "@codeworksh/widget/backend";
import type { Codework as Wire } from "@codeworksh/widget/codework";
import {
	Cause,
	Clock,
	Context,
	Deferred,
	Effect,
	FiberHandle,
	FiberMap,
	FileSystem,
	Layer,
	Option,
	Schema,
	Stream,
	SubscriptionRef,
} from "effect";
import { SqlClient } from "effect/sql";
import type { Publish } from "@codeworksh/widget/event";
import { CodeworkUnavailable, SyncError, type SyncThread, syncTopics } from "@codeworksh/contract";
import { Codework } from "./codework.ts";
import { Event } from "./event.ts";
import { Mirror } from "./mirror.ts";
import { Servers } from "./servers.ts";

type Connection = typeof Client.Service;

/** The space daemon events this server mirrors: the builtin ones the desktop shows. */
const daemonTypes = ["plugin.git.status", "plugin.skills.list"];
/** Where a daemon event belongs and when it was read; the rest is stored as it came. */
const decodePoint = Schema.decodeUnknownOption(Schema.Struct({ spaceId: Schema.String, observedAt: Schema.Number }));
const DataText = Schema.fromJsonString(Schema.Unknown);
type IndexSynced = Extract<Wire.IndexItem, { _tag: "Synced" }>;
type IndexRow = Exclude<Wire.IndexItem, IndexSynced>;
type ThreadSynced = Extract<Wire.ThreadItem, { _tag: "Synced" }>;
type ThreadRow = Exclude<Wire.ThreadItem, ThreadSynced>;
type UsageSynced = Extract<Wire.UsageItem, { _tag: "Synced" }>;
type UsageRow = Exclude<Wire.UsageItem, UsageSynced>;

/** The RPC server's answer to a call it has no handler for: a server older than `usage.sync`. */
const unserved = (cause: Cause.Cause<unknown>) =>
	cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === "Unknown request tag: usage.sync");

/** A machine whose index is current: its connection and the threads whose detail it syncs. */
interface Live {
	readonly client: Connection;
	readonly threads: FiberMap.FiberMap<string>;
}

export interface Interface {
	/** Syncs a thread's detail until every open is closed; done once it is current, or at once while its machine is away. */
	readonly open: (ref: SyncThread) => Effect.Effect<void>;
	readonly close: (ref: SyncThread) => Effect.Effect<void>;
	/** Stores up to `limit` entries below an opened thread's floor, read from its machine. */
	readonly page: (
		ref: SyncThread & { readonly limit: number },
	) => Effect.Effect<{ readonly entries: number; readonly floor: number | null }, CodeworkUnavailable | SyncError>;
	/** The connection to a machine's server, for commands to its sessions. */
	readonly client: (machineId: string) => Effect.Effect<Connection, CodeworkUnavailable>;
	/** The machine a synced session is on. */
	readonly machineOf: (sessionId: string) => Effect.Effect<Option.Option<string>>;
	/**
	 * Done once the machine a session is on (the default one for a session not synced) has applied
	 * its index up to the head its store has now; at once while that machine is away.
	 */
	readonly settle: (sessionId: string) => Effect.Effect<void>;
}

/**
 * Keeps app.db a copy of every machine's CodeWork: each machine over its own connection, its index
 * through `index.sync` from `machine.cursor`, its usage rollup through `usage.sync` from `machine.rollup`, and the detail of opened threads through `thread.sync`
 * from `thread.cursor`. A new or restored store is read again from zero.
 */
export class Service extends Context.Service<Service, Interface>()("@codeworksh/server/sync/Service") {}

const unavailable = (machineId: string) =>
	new CodeworkUnavailable({ message: `The CodeWork server of machine ${machineId} is not connected.` });

/** The route a connection is made from: a change reconnects the machine. */
const routeOf = (row: Servers.Row) =>
	row.kind === "remote" ? `remote ${row.url}` : `local ${row.home ?? ""} ${row.executable ?? ""}`;

/**
 * Runs `apply` on each batch up to its `Synced`, in order; `onItem` sees every other item as it
 * arrives and says whether the batch keeps it.
 */
const batches = <R, S>(
	stream: Stream.Stream<R | S, unknown>,
	isSynced: (item: R | S) => item is S,
	onItem: (item: R) => Effect.Effect<boolean>,
	apply: (rows: ReadonlyArray<R>, synced: S) => Effect.Effect<void, unknown>,
) =>
	Effect.suspend(() => {
		let rows: Array<R> = [];
		return stream.pipe(
			Stream.runForEach((item) => {
				if (!isSynced(item))
					return onItem(item).pipe(
						Effect.map((keep) => {
							if (keep) rows.push(item);
						}),
					);
				const batch = rows;
				rows = [];
				return apply(batch, item);
			}),
		);
	});

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const events = yield* Event.Service;
		const servers = yield* Servers.Service;
		const fs = yield* FileSystem.FileSystem;

		const clients = new Map<string, Connection>();
		const lives = new Map<string, Live>();
		// Open counts by thread: windows open and close a thread independently.
		const opened = new Map<string, number>();
		// Done once a thread's stream applied its first `Synced`; present while its stream runs.
		const readiness = new Map<string, Deferred.Deferred<void>>();
		// The open drafts of opened threads, by thread, entry and part: their text as last known.
		const drafts = new Map<string, Map<string, Map<number, string>>>();
		// Each live machine's index cursor as last applied, including batches that carried no rows.
		const applied = yield* SubscriptionRef.make<ReadonlyMap<string, number>>(new Map());

		// Each batch in one transaction, foreign keys checked at its commit: rows arrive in revision
		// order, so a session can come before the latest version of its space.
		const transact = (
			body: (append: (input: Publish) => Effect.Effect<void>) => Effect.Effect<void, unknown, SqlClient.SqlClient>,
		) =>
			events.transact((append) =>
				sql`PRAGMA defer_foreign_keys = ON`.pipe(
					Effect.andThen(body(append)),
					Effect.provideService(SqlClient.SqlClient, sql),
				),
			);

		const machineOf = (sessionId: string) =>
			sql<{ machineId: string }>`SELECT machine_id FROM session WHERE id = ${sessionId}`.pipe(
				Effect.map((rows) => Option.fromNullishOr(rows[0]?.machineId)),
				Effect.orDie,
			);

		const draftsOf = (threadId: string) => {
			const found = drafts.get(threadId);
			if (found !== undefined) return found;
			const made = new Map<string, Map<number, string>>();
			drafts.set(threadId, made);
			return made;
		};

		// A checkpoint replaces the held text only when it is longer: the held text is the checkpoint
		// plus deltas that continued it exactly, so the longer of the two is the newer.
		const noteEntry = (threadId: string, entry: Wire.HistoryEntry) =>
			Effect.sync(() => {
				const held = draftsOf(threadId);
				if (entry.state !== "draft") return held.delete(entry.id);
				const parts = held.get(entry.id) ?? new Map<number, string>();
				entry.parts.forEach((part, index) => {
					const text = part.type === "text" ? part.text : part.type === "thinking" ? part.thinking : undefined;
					if (text !== undefined && text.length >= (parts.get(index)?.length ?? 0)) parts.set(index, text);
				});
				held.set(entry.id, parts);
			});

		/** Folds a delta into its draft when it continues the held text exactly, and forwards it; drops it otherwise. */
		const fold = (threadId: string, delta: Wire.LiveDelta) =>
			Effect.suspend(() => {
				const held = draftsOf(threadId);
				const parts = held.get(delta.entryId) ?? (delta.offset === 0 ? new Map<number, string>() : undefined);
				const text = parts?.get(delta.partIndex) ?? "";
				if (parts === undefined || text.length !== delta.offset) return Effect.void;
				parts.set(delta.partIndex, text + delta.delta);
				held.set(delta.entryId, parts);
				return events.publish({
					topic: syncTopics.delta(threadId),
					source: "sync",
					payload: delta,
					ephemeral: true,
				});
			});

		const syncThread = (machineId: string, live: Live, sessionId: string, threadId: string) =>
			Effect.gen(function* () {
				const [row] = yield* sql<{ cursor: number | null }>`SELECT cursor FROM thread WHERE id = ${threadId}`;
				if (row === undefined) return;
				yield* batches<ThreadRow, ThreadSynced>(
					live.client("thread.sync", {
						sessionId,
						threadId,
						...(row.cursor === null ? {} : { after: row.cursor }),
					}),
					(item) => item._tag === "Synced",
					(item) =>
						item._tag === "Delta"
							? fold(threadId, item.delta).pipe(Effect.as(false))
							: item._tag === "Entry"
								? noteEntry(threadId, item.entry).pipe(Effect.as(true))
								: Effect.succeed(true),
					(rows, synced) =>
						transact((append) =>
							Effect.gen(function* () {
								const changes = yield* Mirror.thread(threadId, rows);
								yield* sql`
										UPDATE thread SET cursor = ${synced.rev}, floor = COALESCE(${synced.floor ?? null}, floor)
										WHERE id = ${threadId}
									`;
								if (rows.length > 0 || synced.floor !== undefined)
									yield* append({
										topic: syncTopics.changed,
										source: "sync",
										payload: changes.notice({ machineId, threadId, full: false, items: rows.length }),
									});
							}),
						).pipe(Effect.andThen(Effect.suspend(() => readyOf(threadId)))),
				);
			}).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning("Thread sync stopped", cause).pipe(Effect.annotateLogs({ machineId, threadId })),
				),
			);

		const readyOf = (threadId: string) => {
			const ready = readiness.get(threadId);
			return ready === undefined ? Effect.void : Deferred.succeed(ready, undefined).pipe(Effect.asVoid);
		};

		// Starts the opened threads of a machine whose detail is not syncing yet; known by their session.
		const startOpened = (machineId: string, live: Live) =>
			Effect.gen(function* () {
				const ids = [...opened.keys()];
				if (ids.length === 0) return;
				const rows = yield* sql<{ id: string; sessionId: string }>`
					SELECT thread.id, thread.session_id FROM thread JOIN session ON session.id = thread.session_id
					WHERE session.machine_id = ${machineId} AND thread.deleted_at IS NULL AND thread.id IN ${sql.in(ids)}
				`.pipe(Effect.orDie);
				for (const { id, sessionId } of rows) {
					const ready = yield* Deferred.make<void>();
					// Checked and claimed in one step, so two starts of a thread cannot both run it.
					const fresh = yield* Effect.sync(() => {
						if (readiness.has(id)) return false;
						readiness.set(id, ready);
						return true;
					});
					if (!fresh) continue;
					yield* FiberMap.run(
						live.threads,
						id,
						syncThread(machineId, live, sessionId, id).pipe(
							Effect.ensuring(
								Deferred.succeed(ready, undefined).pipe(
									Effect.andThen(
										Effect.sync(() => {
											if (readiness.get(id) === ready) readiness.delete(id);
										}),
									),
								),
							),
						),
						{ onlyIfMissing: true },
					);
				}
			});

		/**
		 * The builtin space daemons' events, into `machine_space_state`. A subscription opens with each space's
		 * last event: it is (re)started after an index batch mirrored spaces, so that replay finds their
		 * rows, and again whenever it fails or ends. Only a newer event replaces a row.
		 */
		const followDaemons = (machineId: string, client: Connection) =>
			client("event.subscribe", { types: daemonTypes }).pipe(
				Stream.filter((frame) => daemonTypes.includes(frame.type)),
				Stream.runForEach((frame) =>
					Effect.gen(function* () {
						const point = decodePoint(frame.data);
						if (Option.isNone(point)) return;
						const { spaceId, observedAt } = point.value;
						const text = yield* Schema.encodeEffect(DataText)(frame.data).pipe(Effect.orDie);
						yield* transact((append) =>
							Effect.gen(function* () {
								const written = yield* sql<{ spaceId: string }>`
									INSERT INTO machine_space_state (machine_id, space_id, type, data, observed_at)
									SELECT ${machineId}, ${spaceId}, ${frame.type}, ${text}, ${observedAt}
									WHERE EXISTS (SELECT 1 FROM space WHERE machine_id = ${machineId} AND id = ${spaceId})
									ON CONFLICT (machine_id, space_id, type) DO UPDATE
									SET data = excluded.data, observed_at = excluded.observed_at
									WHERE machine_space_state.observed_at < excluded.observed_at
									RETURNING space_id
								`;
								if (written.length === 0) return;
								yield* append({
									topic: syncTopics.state,
									source: "sync",
									payload: { machineId, spaceId, type: frame.type },
								});
							}),
						);
					}),
				),
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: Effect.logWarning(`Space daemon events of machine ${machineId} stopped`, cause),
				),
				Effect.andThen(Effect.sleep("1 second")),
				Effect.forever,
			);

		/** Waits forever when another machine already syncs `storeId`: the same server added twice. */
		const unclaimed = (machineId: string, storeId: string) =>
			Effect.gen(function* () {
				const [owner] = yield* sql<{ id: string }>`
					SELECT id FROM machine WHERE store_id = ${storeId} AND id <> ${machineId}
				`;
				if (owner === undefined) return;
				yield* Effect.logWarning(
					`Not syncing machine ${machineId}: its store is already synced as machine ${owner.id}`,
				);
				return yield* Effect.never;
			});

		/** One connection's sync: decides between resume and full sync, then follows the index. */
		const connected = (machineId: string, client: Connection) =>
			Effect.gen(function* () {
				const info = yield* client("server.info", {});
				yield* servers.setHost(machineId, info.host?.name ?? null);
				const [machine] = yield* sql<{ storeId: string | null; cursor: number; namespace: string }>`
					SELECT store_id, cursor, namespace FROM machine WHERE id = ${machineId}
				`;
				if (machine === undefined) return yield* Effect.never;
				yield* unclaimed(machineId, info.storeId);
				let full = info.storeId !== machine.storeId || info.rev < machine.cursor;
				const live: Live = { client, threads: yield* FiberMap.make<string>() };
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						if (lives.get(machineId) === live) lives.delete(machineId);
					}),
				);
				const daemons = yield* FiberHandle.make<never>();
				let following = false;
				yield* batches<IndexRow, IndexSynced>(
					client("index.sync", { after: full ? 0 : machine.cursor }),
					(item) => item._tag === "Synced",
					() => Effect.succeed(true),
					(rows, synced) =>
						Effect.gen(function* () {
							const now = yield* Clock.currentTimeMillis;
							const wasFull = full;
							let spaces = false;
							yield* transact((append) =>
								Effect.gen(function* () {
									const changes = yield* Mirror.index(
										{ id: machineId, namespace: machine.namespace },
										rows,
										now,
										append,
									);
									if (wasFull) yield* Mirror.unseen(machineId, changes, now);
									spaces = changes.space.size > 0;
									yield* sql`
										UPDATE machine SET cursor = ${synced.rev}, store_id = ${synced.storeId} WHERE id = ${machineId}
									`;
									if (rows.length > 0 || wasFull)
										yield* append({
											topic: syncTopics.changed,
											source: "sync",
											payload: changes.notice({ machineId, full: wasFull, items: rows.length }),
										});
								}),
							);
							full = false;
							if (wasFull || spaces || !following) {
								following = true;
								yield* FiberHandle.run(daemons, followDaemons(machineId, client));
							}
							lives.set(machineId, live);
							yield* SubscriptionRef.update(applied, (cursors) => new Map(cursors).set(machineId, synced.rev));
							yield* startOpened(machineId, live);
						}),
				);
				return yield* Effect.fail("The index stream ended");
			}).pipe(Effect.scoped);

		/**
		 * One connection's usage rollup: from `machine.rollup` while the store is the one it counts in,
		 * else from zero. A read from zero is the store's whole state, so its first batch replaces the
		 * store's rows, in one transaction so a failed re-read leaves the old ones: a restored backup, or
		 * a removed server added again, leaves nothing stale. A resume that left the store's line (by
		 * `rollup_boot`) comes back from zero with `reset`; a server older than boots is read from zero
		 * only while its head is behind the cursor.
		 */
		const syncUsage = (machineId: string, client: Connection) =>
			Effect.gen(function* () {
				const info = yield* client("server.info", {});
				const [machine] = yield* sql<{ rollup: number; rollupStore: string | null; rollupBoot: string | null }>`
					SELECT rollup, rollup_store, rollup_boot FROM machine WHERE id = ${machineId}
				`;
				if (machine === undefined) return yield* Effect.never;
				yield* unclaimed(machineId, info.storeId);
				const resumed = info.storeId === machine.rollupStore && info.rev >= machine.rollup;
				let whole = !resumed;
				yield* batches<UsageRow, UsageSynced>(
					client("usage.sync", {
						after: resumed ? machine.rollup : 0,
						...(resumed && machine.rollupBoot !== null ? { boot: machine.rollupBoot } : {}),
					}),
					(item) => item._tag === "Synced",
					() => Effect.succeed(true),
					(rows, synced) =>
						Effect.gen(function* () {
							if (synced.storeId !== info.storeId) return yield* Effect.fail("The usage stream changed store");
							const replaced = whole || synced.reset === true;
							yield* transact((append) =>
								Effect.gen(function* () {
									if (replaced) {
										yield* sql`DELETE FROM usage WHERE store_id = ${synced.storeId}`;
										yield* sql`DELETE FROM tally WHERE store_id = ${synced.storeId}`;
									}
									yield* Mirror.usage(machineId, synced.storeId, rows);
									yield* sql`
										UPDATE machine SET rollup = ${synced.rev}, rollup_store = ${synced.storeId},
											rollup_boot = ${synced.boot ?? null}
										WHERE id = ${machineId}
									`;
									if (rows.length > 0 || replaced)
										yield* append({
											topic: syncTopics.usage,
											source: "sync",
											payload: { machineId, storeId: synced.storeId, items: rows.length },
										});
								}),
							);
							whole = false;
						}),
				);
				return yield* Effect.fail("The usage stream ended");
			});

		/**
		 * {@link syncUsage} for as long as the connection lasts, apart from the index: either may fail
		 * and retry without the other. A server older than `usage.sync` is asked again only after a while.
		 */
		const followUsage = (machineId: string, client: Connection) =>
			syncUsage(machineId, client).pipe(
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: unserved(cause)
							? Effect.logInfo(`Machine ${machineId} does not serve usage.sync`).pipe(
									Effect.andThen(Effect.sleep("1 minute")),
								)
							: Effect.logWarning(`Usage sync of machine ${machineId} stopped`, cause),
				),
				Effect.andThen(Effect.sleep("1 second")),
				Effect.forever,
			);

		/** A machine for as long as it is configured: connected, and reconnected after any drop. */
		const follow = (row: Servers.Row) =>
			Effect.gen(function* () {
				const context = yield* Layer.build(Codework.machine(row)).pipe(
					Effect.provideService(FileSystem.FileSystem, fs),
					Effect.provideService(Servers.Service, servers),
				);
				const client = Context.get(context, Client);
				clients.set(row.id, client);
				yield* Effect.addFinalizer(() => Effect.sync(() => clients.delete(row.id)));
				yield* Effect.forkScoped(followUsage(row.id, client));
				yield* connected(row.id, client).pipe(
					Effect.catchCause((cause) =>
						Effect.logWarning("Machine sync stopped; reconnecting", cause).pipe(
							Effect.annotateLogs({ machineId: row.id }),
						),
					),
					Effect.andThen(Effect.sleep("1 second")),
					Effect.forever,
				);
			}).pipe(Effect.scoped);

		const machines = yield* FiberMap.make<string>();
		const routes = new Map<string, string>();
		yield* servers.watch.pipe(
			Stream.runForEach((rows) =>
				Effect.gen(function* () {
					for (const row of rows) {
						const route = routeOf(row);
						if (routes.get(row.id) === route) continue;
						routes.set(row.id, route);
						yield* FiberMap.run(machines, row.id, follow(row));
					}
					for (const id of routes.keys()) {
						if (rows.some((row) => row.id === id)) continue;
						routes.delete(id);
						yield* FiberMap.remove(machines, id);
					}
				}),
			),
			Effect.forkScoped,
		);

		return Service.of({
			machineOf,
			settle: Effect.fn("Sync.settle")(function* (sessionId) {
				const known = yield* machineOf(sessionId);
				const machineId = Option.isSome(known)
					? known.value
					: (yield* sql<{ id: string }>`SELECT id FROM machine WHERE is_default = 1`.pipe(Effect.orDie))[0]?.id;
				// Its connection, live or still on its first batch (the app just started); none once removed.
				const client =
					machineId === undefined ? undefined : (lives.get(machineId)?.client ?? clients.get(machineId));
				if (machineId === undefined || client === undefined) return;
				// An unreachable machine fails this within the call's timeout.
				const info = yield* Codework.call((client) => client("server.info", {})).pipe(
					Effect.provideService(Client, client),
					Effect.option,
				);
				if (Option.isNone(info)) return;
				const head = info.value.rev;
				// Bounded: a machine that drops mid-wait sends no more batches.
				yield* SubscriptionRef.changes(applied).pipe(
					Stream.filter((cursors) => (cursors.get(machineId) ?? -1) >= head),
					Stream.runHead,
					Effect.timeoutOption("10 seconds"),
				);
			}),
			client: (machineId) =>
				Effect.suspend(() => {
					const client = clients.get(machineId);
					return client === undefined ? Effect.fail(unavailable(machineId)) : Effect.succeed(client);
				}),

			open: Effect.fn("Sync.open")(function* ({ sessionId, threadId }) {
				yield* Effect.sync(() => {
					opened.set(threadId, (opened.get(threadId) ?? 0) + 1);
				});
				const machineId = yield* machineOf(sessionId);
				const live = Option.isSome(machineId) ? lives.get(machineId.value) : undefined;
				if (Option.isNone(machineId) || live === undefined) return;
				yield* startOpened(machineId.value, live);
				const ready = readiness.get(threadId);
				if (ready !== undefined) yield* Deferred.await(ready);
			}),

			close: Effect.fn("Sync.close")(function* ({ threadId }) {
				const left = (opened.get(threadId) ?? 0) - 1;
				yield* Effect.sync(() => {
					if (left > 0) opened.set(threadId, left);
					else {
						opened.delete(threadId);
						drafts.delete(threadId);
					}
				});
				if (left > 0) return;
				yield* Effect.forEach(lives.values(), (live) => FiberMap.remove(live.threads, threadId), { discard: true });
			}),

			page: Effect.fn("Sync.page")(function* ({ sessionId, threadId, limit }) {
				const [row] = yield* sql<{ cursor: number | null; floor: number | null; machineId: string }>`
					SELECT thread.cursor, thread.floor, session.machine_id FROM thread
					JOIN session ON session.id = thread.session_id
					WHERE thread.id = ${threadId} AND thread.session_id = ${sessionId}
				`.pipe(Effect.orDie);
				if (row === undefined || row.cursor === null)
					return yield* new SyncError({ message: `The detail of thread ${threadId} is not synced.` });
				if (row.floor === null) return { entries: 0, floor: null };
				const live = lives.get(row.machineId);
				if (live === undefined) return yield* unavailable(row.machineId);
				const before = row.floor;
				const { entries } = yield* Codework.call(
					(client) => client("thread.page", { sessionId, threadId, before, limit }),
					{ timeout: "30 seconds" },
				).pipe(Effect.provideService(Client, live.client));
				const floor = Math.min(before, ...entries.map((entry) => entry.seq));
				yield* transact((append) =>
					Effect.gen(function* () {
						const changes = new Mirror.Changes();
						yield* Mirror.entries(entries, changes);
						yield* sql`UPDATE thread SET floor = ${floor} WHERE id = ${threadId}`;
						yield* append({
							topic: syncTopics.changed,
							source: "sync",
							payload: changes.notice({
								machineId: row.machineId,
								threadId,
								full: false,
								items: entries.length,
							}),
						});
					}),
				).pipe(Effect.orDie);
				return { entries: entries.length, floor };
			}),
		});
	}),
);

export * as Sync from "./sync.ts";
