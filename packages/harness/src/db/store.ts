import { Context, Effect, Layer, PubSub, type Scope } from "effect";
import { SqlClient, type SqlError } from "effect/sql";

/** The store's identity and its last revision taken. */
export interface Head {
	readonly id: string;
	readonly rev: number;
}

export interface Interface {
	/**
	 * Runs `effect` as one write transaction, or inside the enclosing one. Every write to project,
	 * space, session, thread, entry or inbox goes through it. After a commit that took a revision,
	 * the doorbell rings.
	 */
	readonly write: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SqlError.SqlError, R>;
	/** The enclosing write's revision, taken on first use; every row the write touches is stamped with it. */
	readonly rev: Effect.Effect<number>;
	readonly head: Effect.Effect<Head>;
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

		const write = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError.SqlError, R> =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					if ((yield* Taken) !== undefined) return yield* restore(effect);
					const taken: { rev: number | undefined } = { rev: undefined };
					const result = yield* sql.withTransaction(restore(Effect.provideService(effect, Taken, taken)));
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
			const [row] = yield* sql<Head>`SELECT id, rev FROM store`;
			if (row === undefined) return yield* Effect.die(new Error("store row is missing"));
			return row;
		}).pipe(Effect.orDie);

		const wake = Effect.gen(function* () {
			const pubsub = yield* PubSub.sliding<void>(1);
			const subscription = yield* PubSub.subscribe(pubsub);
			yield* Effect.acquireRelease(
				Effect.sync(() => wakes.add(pubsub)),
				() => Effect.sync(() => wakes.delete(pubsub)).pipe(Effect.andThen(PubSub.shutdown(pubsub))),
			);
			return subscription;
		});

		return Service.of({ write, rev, head, wake });
	}),
);

export * as Store from "./store.ts";
