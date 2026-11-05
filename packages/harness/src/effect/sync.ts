import { DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema, type Statement } from "effect/sql";
import { ProjectRow, SpaceRow } from "../db/schema.sql.ts";
import type { ProjectSchema } from "../project/schema.ts";
import type { AbsolutePath } from "../schema.ts";
import type { SpaceSchema } from "../space/schema.ts";
import { SessionSchema } from "../session/schema.ts";
import { ThreadSchema } from "../thread/schema.ts";
import { type Info, info, type ThreadSummary, threadSummary } from "./session.ts";

/** Where a read in revision order stands: past revision `rev` whole, or past `key` within it. */
export interface Cursor {
	readonly rev: number;
	readonly key?: { readonly kind: string; readonly id: string };
}

export interface Page<A> {
	readonly items: ReadonlyArray<A>;
	/** Where the next page starts; absent once the range is read. */
	readonly next?: Cursor;
}

const Row = Schema.Struct({ kind: Schema.String, id: Schema.String, rev: Schema.Int });
type Row = typeof Row.Type;
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

/**
 * One page of the rows `select` names, as `kind`, `id` and `rev`, past `from` and up to revision
 * `upto`, in `(rev, kind, id)` order. `select` filters each table on the revision range it is given,
 * so every table reads through its `rev` index. Rows of one revision can span pages.
 */
export const page = Effect.fn("Sync.page")(function* (
	select: (range: Statement.Fragment) => Statement.Fragment,
	from: Cursor,
	upto: number,
	limit: number,
) {
	const sql = yield* SqlClient.SqlClient;
	const after =
		from.key === undefined
			? sql`rev > ${from.rev}`
			: sql`(rev, kind, id) > (${from.rev}, ${from.key.kind}, ${from.key.id})`;
	const rows = yield* sql`
		SELECT kind, id, rev FROM (${select(sql`rev >= ${from.rev} AND rev <= ${upto}`)})
		WHERE ${after}
		ORDER BY rev, kind, id
		LIMIT ${limit}
	`.pipe(Effect.flatMap(decodeRows), Effect.orDie);
	const last = rows.at(-1);
	return {
		items: rows,
		...(last === undefined || rows.length < limit
			? {}
			: { next: { rev: last.rev, key: { kind: last.kind, id: last.id } } }),
	} satisfies Page<Row>;
});

export interface ProjectInfo {
	readonly id: string;
	readonly name: string;
	readonly status: ProjectSchema.Status;
	/** Epoch milliseconds. */
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface SpaceInfo {
	readonly id: string;
	readonly projectId: string;
	readonly location: AbsolutePath;
	readonly kind: SpaceSchema.Kind;
	/** The sandbox it is in; absent for the host. */
	readonly env?: string;
	readonly status: SpaceSchema.Status;
	/** Epoch milliseconds. */
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** A row of the index (every project, space, session and thread) at the revision that last wrote it. */
export type IndexChange =
	| { readonly _tag: "Project"; readonly project: ProjectInfo; readonly rev: number }
	| { readonly _tag: "Space"; readonly space: SpaceInfo; readonly rev: number }
	| { readonly _tag: "Session"; readonly session: Info; readonly rev: number }
	| { readonly _tag: "Thread"; readonly thread: ThreadSummary; readonly rev: number }
	/** Only sessions are deleted; their threads go with them. */
	| { readonly _tag: "Removed"; readonly kind: "session"; readonly id: string; readonly rev: number };

/**
 * One page of the index rows past `from`, up to revision `upto`, read as one snapshot so every row
 * the page names is still there to read.
 */
export const index = Effect.fn("Sync.index")(function* (from: Cursor, upto: number, limit: number) {
	const sql = yield* SqlClient.SqlClient;
	const findProject = SqlSchema.findOne({
		Request: Schema.String,
		Result: ProjectRow,
		execute: (id) => sql`SELECT * FROM project WHERE id = ${id}`,
	});
	const findSpace = SqlSchema.findOne({
		Request: Schema.String,
		Result: SpaceRow,
		execute: (id) => sql`SELECT * FROM space WHERE id = ${id}`,
	});
	const select = (range: Statement.Fragment) => sql`
		SELECT 'project' AS kind, id, rev FROM project WHERE ${range}
		UNION ALL SELECT 'space', id, rev FROM space WHERE ${range}
		UNION ALL SELECT 'session', id, rev FROM session WHERE ${range}
		UNION ALL SELECT 'thread', id, rev FROM thread WHERE ${range}
		UNION ALL SELECT 'removed', id, rev FROM removed WHERE kind = 'session' AND ${range}
	`;
	const change = Effect.fnUntraced(function* ({ kind, id, rev }: Row) {
		switch (kind) {
			case "project": {
				const row = yield* findProject(id);
				return {
					_tag: "Project",
					project: {
						id: row.id,
						name: row.name,
						status: row.status,
						createdAt: DateTime.toEpochMillis(row.createdAt),
						updatedAt: DateTime.toEpochMillis(row.updatedAt),
					},
					rev,
				} satisfies IndexChange;
			}
			case "space": {
				const row = yield* findSpace(id);
				const env = Option.getOrUndefined(row.env);
				return {
					_tag: "Space",
					space: {
						id: row.id,
						projectId: row.projectId,
						location: row.location,
						kind: row.kind,
						...(env === undefined ? {} : { env }),
						status: row.status,
						createdAt: DateTime.toEpochMillis(row.createdAt),
						updatedAt: DateTime.toEpochMillis(row.updatedAt),
					},
					rev,
				} satisfies IndexChange;
			}
			case "session":
				return { _tag: "Session", session: yield* info(SessionSchema.ID.make(id)), rev } satisfies IndexChange;
			case "thread":
				return {
					_tag: "Thread",
					thread: yield* threadSummary(ThreadSchema.ID.make(id)),
					rev,
				} satisfies IndexChange;
			default:
				return { _tag: "Removed", kind: "session", id, rev } satisfies IndexChange;
		}
	});
	return yield* sql
		.withTransaction(
			Effect.gen(function* () {
				const { items, next } = yield* page(select, from, upto, limit);
				return {
					items: yield* Effect.forEach(items, change),
					...(next === undefined ? {} : { next }),
				} satisfies Page<IndexChange>;
			}),
		)
		.pipe(Effect.orDie);
});

export * as Sync from "./sync.ts";
