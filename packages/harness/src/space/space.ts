import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlError, SqlSchema } from "effect/unstable/sql";
import { SpaceRow } from "../db/schema.sql.ts";
import { ProjectSchema } from "../project/schema.ts";
import { SandboxInstance } from "../sandbox/instance.ts";
import { SandboxIO } from "../sandbox/io.ts";
import type { Sandbox } from "../sandbox/sandbox.ts";
import { AbsolutePath, RelativePath } from "../schema.ts";
import { Hash } from "../util/hash.ts";
import { SpaceSchema } from "./schema.ts";

/** `hash(env, location)` — no project component (D-SPACEID). */
export const id = (env: SandboxInstance.ID, location: string): SpaceSchema.ID =>
	SpaceSchema.ID.make(Hash.fast(JSON.stringify([SandboxInstance.toColumn(env) ?? "local", location])));

export interface RehomeInput {
	readonly id: SpaceSchema.ID;
	readonly projectId: ProjectSchema.ID;
	readonly location: AbsolutePath;
	readonly kind: SpaceSchema.Kind;
	readonly env: SandboxInstance.ID;
}

export interface AbsorbInput {
	readonly strayId: SpaceSchema.ID;
	readonly into: SpaceSchema.ID;
	/** The stray's location relative to the absorbing space. */
	readonly rel: RelativePath;
}

export interface Interface {
	readonly get: (id: SpaceSchema.ID) => Effect.Effect<Option.Option<SpaceSchema.Info>>;
	/** Active spaces of the project in this env, sorted by location. */
	readonly list: (projectId: ProjectSchema.ID) => Effect.Effect<SpaceSchema.Info[]>;
	/** Probe every space of the project in this env, archive/re-activate/promote (§5.4), then `list`. */
	readonly refresh: (projectId: ProjectSchema.ID) => Effect.Effect<SpaceSchema.Info[]>;
	/** Archive every space of an env; archive projects left without an active space (§5.5). */
	readonly archiveEnv: (env: SandboxInstance.ID) => Effect.Effect<void>;
	/** Upsert (§5.2). The only way resolve writes a space row. */
	readonly rehome: (input: RehomeInput) => Effect.Effect<void>;
	/** Move a stray subdirectory space's sessions onto its parent, then delete it (§5.3). */
	readonly absorb: (input: AbsorbInput) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/space/space/Service") {}

/** Row → public shape. Shared with `Session.space`, which reads the same row through a join. */
export const fromRow = (row: SpaceRow): SpaceSchema.Info =>
	new SpaceSchema.Info({
		id: SpaceSchema.ID.make(row.id),
		projectId: ProjectSchema.ID.make(row.projectId),
		location: row.location,
		kind: row.kind,
		env: SandboxInstance.fromField(row.env),
		status: row.status,
	});

/**
 * Archive every space of an env, then every touched project left without an
 * active space in any env (§5.5). Requires only `SqlClient` so the sandbox
 * controller can run it inside its destroy tombstone transaction (D-ENV).
 * Write-first so a DEFERRED transaction takes the write lock immediately.
 */
export const archiveEnv = Effect.fn("Space.archiveEnv")(function* (env: SandboxInstance.ID) {
	const sql = yield* SqlClient.SqlClient;
	const column = SandboxInstance.toColumn(env);
	const now = yield* Clock.currentTimeMillis;
	yield* sql
		.withTransaction(
			Effect.gen(function* () {
				yield* sql`UPDATE space SET status = 'archived', updated_at = ${now} WHERE env IS ${column}`;
				yield* sql`
					UPDATE project SET status = 'archived', updated_at = ${now}
					WHERE id IN (SELECT project_id FROM space WHERE env IS ${column})
						AND NOT EXISTS (SELECT 1 FROM space WHERE space.project_id = project.id AND status = 'active')
				`;
			}),
		)
		.pipe(Effect.orDie);
});

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const fs = yield* SandboxIO.FileSystem;
		const { id: env } = yield* SandboxIO.Current;
		// NULL for the host; compared with `IS`, never `=`.
		const envColumn = SandboxInstance.toColumn(env);

		const findOne = SqlSchema.findOneOption({
			Request: Schema.String,
			Result: SpaceRow,
			execute: (id) => sql`SELECT * FROM space WHERE id = ${id}`,
		});

		const findByProject = SqlSchema.findAll({
			Request: Schema.Struct({ projectId: Schema.String, env: Schema.NullOr(Schema.String) }),
			Result: SpaceRow,
			execute: ({ projectId, env }) => sql`SELECT * FROM space WHERE project_id = ${projectId} AND env IS ${env}`,
		});

		const insertSpace = SqlSchema.void({
			Request: SpaceRow.insert,
			execute: (row) => sql`
				INSERT INTO space ${sql.insert(row)}
				ON CONFLICT(id) DO UPDATE SET
					project_id = excluded.project_id,
					kind = excluded.kind,
					status = 'active',
					updated_at = excluded.updated_at
			`,
		});

		// Projects with no active space in any env are archived, never deleted.
		const archiveOrphanProjects = (projectIds: ReadonlyArray<string>, now: number) =>
			Effect.forEach(
				projectIds,
				(projectId) => sql`
					UPDATE project SET status = 'archived', updated_at = ${now}
					WHERE id = ${projectId}
						AND NOT EXISTS (SELECT 1 FROM space WHERE project_id = ${projectId} AND status = 'active')
				`,
				{ discard: true },
			);

		const get = Effect.fn("Space.get")(function* (id: SpaceSchema.ID) {
			return Option.map(yield* findOne(id).pipe(Effect.orDie), fromRow);
		});

		const list = Effect.fn("Space.list")(function* (projectId: ProjectSchema.ID) {
			const rows = yield* findByProject({ projectId, env: envColumn }).pipe(Effect.orDie);
			return rows
				.filter((row) => row.status === "active")
				.toSorted((a, b) => a.location.localeCompare(b.location))
				.map(fromRow);
		});

		const refresh = Effect.fn("Space.refresh")(function* (projectId: ProjectSchema.ID) {
			const rows = yield* findByProject({ projectId, env: envColumn }).pipe(Effect.orDie);

			// Three-way: keep, gone, or unknown. Only a definitive "absent" archives;
			// a backend that could not answer leaves the row alone.
			const probed = yield* Effect.forEach(
				rows,
				(row) =>
					fs.exists(row.location).pipe(
						Effect.map((exists) => ({ row, gone: !exists })),
						Effect.orElseSucceed(() => ({ row, gone: false })),
					),
				{ concurrency: "unbounded" },
			);
			const gone = probed.filter((entry) => entry.gone).map((entry) => entry.row.id);
			const returned = probed
				.filter((entry) => !entry.gone && entry.row.status === "archived")
				.map((entry) => entry.row.id);

			const now = yield* Clock.currentTimeMillis;
			yield* sql
				.withTransaction(
					Effect.gen(function* () {
						if (gone.length > 0) {
							yield* sql`UPDATE space SET status = 'archived', updated_at = ${now} WHERE ${sql.in("id", gone)}`;
						}
						if (returned.length > 0) {
							yield* sql`UPDATE space SET status = 'active', updated_at = ${now} WHERE ${sql.in("id", returned)}`;
						}

						const primary = yield* sql`
							SELECT id FROM space
							WHERE project_id = ${projectId} AND env IS ${envColumn} AND kind = 'primary' AND status = 'active'
						`;
						if (primary.length === 0) {
							// The unique index ignores status: demote the archived primary
							// before promoting. Only a copy qualifies — a linked worktree's
							// store died with the primary, and plain never needs one.
							yield* sql`
								UPDATE space SET kind = 'copy', updated_at = ${now}
								WHERE project_id = ${projectId} AND env IS ${envColumn} AND kind = 'primary'
							`;
							yield* sql`
								UPDATE space SET kind = 'primary', updated_at = ${now}
								WHERE id = (
									SELECT id FROM space
									WHERE project_id = ${projectId} AND env IS ${envColumn} AND status = 'active' AND kind = 'copy'
									ORDER BY created_at ASC LIMIT 1
								)
							`;
						}

						yield* archiveOrphanProjects([projectId], now);
					}),
				)
				.pipe(Effect.orDie);

			return yield* list(projectId);
		});

		const rehome = Effect.fn("Space.rehome")(function* (input: RehomeInput) {
			const write = (kind: SpaceSchema.Kind) =>
				SpaceRow.insert
					.makeEffect({
						id: input.id,
						projectId: input.projectId,
						location: input.location,
						kind,
						env: SandboxInstance.toField(input.env),
						status: "active",
					})
					.pipe(Effect.flatMap(insertSpace));

			// A concurrent primary claim cannot happen under the resolve lock, but
			// the guard is cheap: the loser becomes a copy.
			yield* write(input.kind).pipe(
				Effect.catchIf(
					(error) =>
						input.kind === "primary" &&
						SqlError.isSqlError(error) &&
						error.reason._tag === "UniqueViolation" &&
						error.reason.constraint.includes("space_primary_idx"),
					() => write("copy"),
				),
				Effect.orDie,
			);
		});

		const absorb = Effect.fn("Space.absorb")(function* (input: AbsorbInput) {
			const now = yield* Clock.currentTimeMillis;
			yield* sql`
				UPDATE session SET
					space_id = ${input.into},
					directory = CASE directory WHEN '' THEN ${input.rel} ELSE ${input.rel} || '/' || directory END,
					updated_at = ${now}
				WHERE space_id = ${input.strayId}
			`.pipe(Effect.orDie);
			yield* sql`DELETE FROM space WHERE id = ${input.strayId}`.pipe(Effect.orDie);
		});

		return Service.of({
			get,
			list,
			refresh,
			archiveEnv: (target) => archiveEnv(target).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
			rehome,
			absorb,
		});
	}),
);

export const layerWith = <E, RIn>(sandbox: Sandbox.Sandbox<E, RIn>) => layer.pipe(Layer.provide(sandbox));

export * as Space from "./space.ts";
