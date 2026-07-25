import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { SandboxInstanceRow } from "../db/schema.sql";
import { SandboxInstance } from "./instance";

/**
 * Row-level access to `sandbox_instance`. Deliberately dumb: it persists and
 * reads instance rows and knows nothing about drivers, provisioning, reference
 * counts, or lifecycle rules. `Sandbox.Controller` is added on top of this and
 * owns all of that.
 *
 * State transitions are single conditional statements verified by affected-row
 * count, never a read-then-write transaction: `SqlClient` begins DEFERRED, and
 * under WAL a mid-transaction lock upgrade can fail with `SQLITE_BUSY_SNAPSHOT`,
 * which `busy_timeout` does not retry.
 */

export interface RegisterInput {
	readonly id: SandboxInstance.ID;
	readonly driver: string;
	readonly kind: SandboxInstance.Kind;
	readonly ownership: SandboxInstance.Ownership;
	readonly status?: SandboxInstance.Status;
	readonly providerResourceId?: string;
	readonly runtimeConfig?: string;
	readonly metadata?: Readonly<Record<string, string>>;
}

export interface Interface {
	readonly find: (id: SandboxInstance.ID) => Effect.Effect<Option.Option<SandboxInstanceRow>>;
	readonly list: Effect.Effect<ReadonlyArray<SandboxInstanceRow>>;
	/** Insert if absent, leaving an existing row untouched. Idempotent. */
	readonly register: (input: RegisterInput) => Effect.Effect<SandboxInstanceRow>;
	/**
	 * Compare-and-set the lifecycle state. Returns whether the row moved, so a
	 * caller can distinguish "I own this transition" from "someone beat me".
	 */
	readonly transition: (input: {
		readonly id: SandboxInstance.ID;
		readonly from: ReadonlyArray<SandboxInstance.Status>;
		readonly to: SandboxInstance.Status;
	}) => Effect.Effect<boolean>;
	/**
	 * Re-assert a reconstructible namespace's row from its canonical definition.
	 *
	 * Unlike {@link register}, this upserts: a fixture's row holds only facts we
	 * can re-derive from configuration, so writing them again is a repair, not an
	 * overwrite. Clear the database and the next `ensure` restores the row — which
	 * is the point, since Project and Session foreign-key to it.
	 *
	 * Only for `kind !== "remote"`. A remote row is the sole record that provider
	 * infrastructure exists; nothing can re-derive it, and re-asserting a status
	 * would discard a real observation.
	 */
	readonly ensure: (fixture: SandboxInstance.Fixture) => Effect.Effect<SandboxInstanceRow>;
}

export const make = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;

	const findRow = SqlSchema.findOneOption({
		Request: SandboxInstance.ID,
		Result: SandboxInstanceRow,
		execute: (id) => sql`SELECT * FROM sandbox_instance WHERE id = ${id}`,
	});

	const listRows = SqlSchema.findAll({
		Request: Schema.Void,
		Result: SandboxInstanceRow,
		execute: () => sql`SELECT * FROM sandbox_instance ORDER BY created_at`,
	});

	// ON CONFLICT(id), not OR IGNORE: the ignore must cover exactly the
	// idempotency case. OR IGNORE would also swallow a violation of the
	// (driver, provider_resource_id) unique index — a new id aliasing an
	// existing namespace — and surface it as an inexplicable missing row.
	const insertRow = SqlSchema.void({
		Request: SandboxInstanceRow.insert,
		execute: (row) => sql`INSERT INTO sandbox_instance ${sql.insert(row)} ON CONFLICT(id) DO NOTHING`,
	});

	const find = (id: SandboxInstance.ID) => findRow(id).pipe(Effect.orDie);

	const list = listRows(undefined).pipe(Effect.orDie);

	const register = Effect.fn("SandboxStore.register")(function* (input: RegisterInput) {
		const row = yield* SandboxInstanceRow.insert
			.makeEffect({
				id: input.id,
				driver: input.driver,
				kind: input.kind,
				providerResourceId: Option.fromUndefinedOr(input.providerResourceId),
				runtimeConfig: Option.fromUndefinedOr(input.runtimeConfig),
				ownership: input.ownership,
				status: input.status ?? "online",
				providerStatus: Option.none(),
				// stateObservedAt defaults to the injected Clock's now
				metadata: Option.fromUndefinedOr(input.metadata as Record<string, string> | undefined),
				lastError: Option.none(),
				lastAcquiredAt: Option.none(),
				lastReleasedAt: Option.none(),
				lastUsedAt: Option.none(),
				removedAt: Option.none(),
			})
			.pipe(Effect.orDie);

		yield* insertRow(row).pipe(Effect.orDie);

		const stored = yield* find(input.id);
		if (Option.isNone(stored))
			return yield* Effect.die(new Error(`sandbox instance insert did not persist: ${input.id}`));
		return stored.value;
	});

	const transition = Effect.fn("SandboxStore.transition")(function* (input: {
		readonly id: SandboxInstance.ID;
		readonly from: ReadonlyArray<SandboxInstance.Status>;
		readonly to: SandboxInstance.Status;
	}) {
		const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
		// RETURNING makes "did I win this transition?" part of the same statement.
		// Re-reading afterwards would answer a different question, since another
		// writer may have moved the row in between.
		const moved = yield* sql`
			UPDATE sandbox_instance
			SET status = ${input.to}, updated_at = ${now}
			WHERE id = ${input.id} AND ${sql.in("status", input.from)}
			RETURNING id
		`.pipe(Effect.orDie);
		return moved.length > 0;
	});

	const ensure = Effect.fn("SandboxStore.ensure")(function* (fixture: SandboxInstance.Fixture) {
		const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
		// One statement, so concurrent callers cannot race — §7.2's rule. The
		// conflict clause restores identity and the observation only: created_at
		// and the usage timestamps are history, and a repair must not rewrite them.
		yield* sql`
			INSERT INTO sandbox_instance
				(id, driver, kind, ownership, status, runtime_config, state_observed_at, created_at, updated_at)
			VALUES (
				${fixture.id}, ${fixture.driver}, ${fixture.kind}, ${fixture.ownership},
				${fixture.status}, ${fixture.runtimeConfig}, ${now}, ${now}, ${now}
			)
			ON CONFLICT(id) DO UPDATE SET
				driver = excluded.driver,
				kind = excluded.kind,
				ownership = excluded.ownership,
				status = excluded.status,
				runtime_config = excluded.runtime_config,
				state_observed_at = excluded.state_observed_at,
				updated_at = excluded.updated_at
		`.pipe(Effect.orDie);

		const stored = yield* find(fixture.id);
		if (Option.isNone(stored))
			return yield* Effect.die(new Error(`sandbox instance fixture did not persist: ${fixture.id}`));
		return stored.value;
	});

	return { find, list, register, transition, ensure } satisfies Interface;
});

/**
 * A database plus the namespace fixtures its own foreign keys depend on.
 *
 * `project_directory` and `session` reference `sandbox_instance`, so the host row
 * has to exist before either can record where it lives. That row is not schema —
 * what `local` *is* belongs to the sandbox domain, and a migration cannot seed it
 * without both mixing DML into DDL and reaching for a wall clock the rest of the
 * codebase does not use. It is also not one-shot: the migrator runs by high-water
 * mark, so a migration-seeded row is gone for good once deleted, whereas this
 * re-asserts on every runtime build.
 *
 * The dependency points this way — sandbox wraps database, not the reverse — so
 * `db/` stays generic infrastructure with no domain imports.
 */
export const withFixtures = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
	Layer.effectDiscard(Effect.flatMap(make, (store) => store.ensure(SandboxInstance.localFixture))).pipe(
		Layer.provideMerge(database),
	);

export * as SandboxStore from "./store";
