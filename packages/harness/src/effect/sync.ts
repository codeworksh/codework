import { DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema, type Statement } from "effect/sql";
import { InboxRow, ProjectRow, SpaceRow } from "../db/schema.sql.ts";
import { Inbox } from "../inbox/inbox.ts";
import type { Admitted } from "../inbox/schema.ts";
import type { ProjectSchema } from "../project/schema.ts";
import type { AbsolutePath } from "../schema.ts";
import type { SpaceSchema } from "../space/schema.ts";
import { SessionSchema } from "../session/schema.ts";
import { ThreadSchema } from "../thread/schema.ts";
import { Thread } from "../thread/thread.ts";
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

export type InboxState = "pending" | "promoted" | "cancelled";

/** A row of one thread's detail at the revision that last wrote it. */
export type ThreadChange =
	| { readonly _tag: "Entry"; readonly entry: Thread.HydratedEntry; readonly rev: number }
	| { readonly _tag: "Inbox"; readonly prompt: Admitted; readonly state: InboxState; readonly rev: number };

const toInbox = (row: InboxRow): ThreadChange => {
	const prompt = Inbox.fromRow(row);
	const state =
		prompt.promotedSeq !== undefined ? "promoted" : prompt.cancelledSeq !== undefined ? "cancelled" : "pending";
	return { _tag: "Inbox", prompt, state, rev: row.rev };
};

/**
 * One page of a thread's own user and assistant entries and inbox rows past `from`, up to revision
 * `upto`, read as one snapshot. Inherited entries never change after the fork's cut, so a resume
 * does not read them.
 */
export const thread = Effect.fn("Sync.thread")(function* (
	threadId: ThreadSchema.ID,
	from: Cursor,
	upto: number,
	limit: number,
) {
	const sql = yield* SqlClient.SqlClient;
	const threads = yield* Thread.Service;
	const findInbox = SqlSchema.findOne({
		Request: Schema.String,
		Result: InboxRow,
		execute: (id) => sql`SELECT * FROM inbox WHERE id = ${id}`,
	});
	const select = (range: Statement.Fragment) => sql`
		SELECT 'entry' AS kind, id, rev FROM entry
		WHERE thread_id = ${threadId} AND type IN ('user', 'assistant') AND ${range}
		UNION ALL SELECT 'inbox', id, rev FROM inbox WHERE thread_id = ${threadId} AND ${range}
	`;
	const change = Effect.fnUntraced(function* ({ kind, id, rev }: Row) {
		if (kind === "inbox") return toInbox(yield* findInbox(id));
		const entry = yield* threads.entry(id);
		if (Option.isNone(entry)) return yield* Effect.die(new Error(`entry ${id} is missing`));
		return { _tag: "Entry", entry: entry.value, rev } satisfies ThreadChange;
	});
	return yield* sql
		.withTransaction(
			Effect.gen(function* () {
				const { items, next } = yield* page(select, from, upto, limit);
				return {
					items: yield* Effect.forEach(items, change),
					...(next === undefined ? {} : { next }),
				} satisfies Page<ThreadChange>;
			}),
		)
		.pipe(Effect.orDie);
});

/**
 * A thread's first page, read as one snapshot: the newest entries of its line within `budget`
 * bytes and `limit` entries (`Thread.linePage`), oldest first, then its pending inbox in admission
 * order. `floor` is the oldest entry's seq.
 */
export const open = Effect.fn("Sync.open")(function* (threadId: ThreadSchema.ID, budget: number, limit: number) {
	const sql = yield* SqlClient.SqlClient;
	const threads = yield* Thread.Service;
	const selectPending = SqlSchema.findAll({
		Request: Schema.String,
		Result: InboxRow,
		execute: (id) => sql`
			SELECT * FROM inbox
			WHERE thread_id = ${id} AND promoted_seq IS NULL AND cancelled_seq IS NULL
			ORDER BY admitted_seq
		`,
	});
	return yield* sql
		.withTransaction(
			Effect.gen(function* () {
				const entries = (yield* threads.linePage({ threadId, budget, limit })).toReversed();
				const pending = yield* selectPending(threadId);
				const floor = entries[0]?.entry.seq;
				return {
					items: [
						...entries.map((entry): ThreadChange => ({ _tag: "Entry", entry, rev: entry.entry.rev })),
						...pending.map(toInbox),
					],
					...(floor === undefined ? {} : { floor }),
				};
			}),
		)
		.pipe(Effect.orDie);
});

export * as Sync from "./sync.ts";
