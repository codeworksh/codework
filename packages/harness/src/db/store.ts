import { Clock, Context, Effect, Layer, PubSub, type Scope } from "effect";
import { SqlClient, type SqlError } from "effect/sql";

/** The store's identity, its last revision taken, and its latest open (`boot`). */
export interface Head {
	readonly id: string;
	readonly rev: number;
	readonly boot: string;
}

export interface Interface {
	/**
	 * Runs `effect` as one write transaction, or inside the enclosing one. Every write to project,
	 * space, session, thread, entry or inbox goes through it. Before a commit that took a revision, it
	 * moves `updated_at` of every thread written in it or below it, and of every session row written in
	 * it; after the commit, the doorbell rings.
	 */
	readonly write: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SqlError.SqlError, R>;
	/** The enclosing write's revision, taken on first use; every row the write touches is stamped with it. */
	readonly rev: Effect.Effect<number>;
	readonly head: Effect.Effect<Head>;
	/**
	 * Whether a client that read up to `rev` while `boot` was the latest open is still on this store's
	 * line: `boot` is known and every open since came at `rev` or later. A restored backup fails it once
	 * the client had read past the backup.
	 */
	readonly onLine: (boot: string, rev: number) => Effect.Effect<boolean>;
	/**
	 * A doorbell for the caller's scope, rung after every commit that took a revision. Register it
	 * before reading `head`, so no commit falls between the read and the first ring.
	 */
	readonly wake: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/db/store/Service") {}

// The revision taken by the write transaction in progress; absent outside `write`.
const Taken = Context.Reference<{ rev: number | undefined } | undefined>("@codeworksh/harness/db/store/Taken", {
	defaultValue: () => undefined,
});

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const wakes = new Set<PubSub.PubSub<void>>();

		const ring = Effect.forEach(wakes, (wake) => PubSub.publish(wake, undefined), { discard: true });

		// Rows a write touches carry its revision, so they say what changed: a thread moves with any change
		// to itself or below it, and the move is stamped too, so sync sends it. A session moves only with its
		// own row: its activity is its newest thread's, read at query time.
		const touch = (rev: number) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis;
				yield* sql`
					UPDATE thread SET updated_at = ${now}, rev = ${rev}
					WHERE rev = ${rev}
						OR id IN (SELECT thread_id FROM entry WHERE rev = ${rev} UNION SELECT thread_id FROM inbox WHERE rev = ${rev})
				`;
				yield* sql`
					UPDATE session SET updated_at = ${now} WHERE rev = ${rev}
				`;
			});

		const write = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError.SqlError, R> =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					if ((yield* Taken) !== undefined) return yield* restore(effect);
					const taken: { rev: number | undefined } = { rev: undefined };
					const result = yield* sql.withTransaction(
						restore(Effect.provideService(effect, Taken, taken)).pipe(
							Effect.tap(() => (taken.rev === undefined ? Effect.void : touch(taken.rev))),
						),
					);
					if (taken.rev !== undefined) yield* ring;
					return result;
				}),
			);

		const rev = Effect.gen(function* () {
			const taken = yield* Taken;
			if (taken === undefined) return yield* Effect.die(new Error("Store.rev outside Store.write"));
			if (taken.rev === undefined) {
				const [row] = yield* sql<{ readonly rev: number }>`UPDATE store SET rev = rev + 1 RETURNING rev`;
				if (row === undefined) return yield* Effect.die(new Error("store row is missing"));
				taken.rev = row.rev;
			}
			return taken.rev;
		}).pipe(Effect.orDie);

		const head = Effect.gen(function* () {
			const [row] = yield* sql<Head>`
				SELECT id, rev, (SELECT id FROM boot ORDER BY seq DESC LIMIT 1) AS boot FROM store
			`;
			if (row === undefined) return yield* Effect.die(new Error("store row is missing"));
			return row;
		}).pipe(Effect.orDie);

		const onLine = Effect.fn("Store.onLine")(function* (boot: string, rev: number) {
			const [own] = yield* sql<{ readonly seq: number }>`SELECT seq FROM boot WHERE id = ${boot}`;
			if (own === undefined) return false;
			const [later] = yield* sql<{ readonly since: number | null }>`
				SELECT MIN(rev) AS since FROM boot WHERE seq > ${own.seq}
			`;
			return later === undefined || later.since === null || later.since >= rev;
		}, Effect.orDie);

		const wake = Effect.gen(function* () {
			const pubsub = yield* PubSub.sliding<void>(1);
			const subscription = yield* PubSub.subscribe(pubsub);
			yield* Effect.acquireRelease(
				Effect.sync(() => wakes.add(pubsub)),
				() => Effect.sync(() => wakes.delete(pubsub)).pipe(Effect.andThen(PubSub.shutdown(pubsub))),
			);
			return subscription;
		});

		return Service.of({ write, rev, head, onLine, wake });
	}),
);
