import { Clock, Effect, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import type { Publish } from "@codeworksh/widget/event";
import {
	type Grouping,
	Position,
	Priority,
	type SyncStatus,
	type SyncTracking,
	syncTopics,
	type ThreadStatus,
	TrackingError,
} from "@codeworksh/contract";
import { Event } from "./event.ts";
import { Ordering } from "./ordering.ts";

/*
 * The user's edits of the desktop columns: status, priority, group, order and color. Each is written
 * with its bus event in one transaction, so every window and widget follows it.
 */

type Append = (input: Publish) => Effect.Effect<void>;
type Fields = Omit<Extract<SyncTracking, { _tag: "Thread" }>, "_tag" | "threadId">;

const SOURCE = "tracking";
const HEX = /^#[0-9a-f]{6}$/i;
const isPriority = Schema.is(Priority);

const fail = (message: string) => Effect.fail(new TrackingError({ message }));
const missing = (what: string, id: string) => fail(`No ${what} ${id}.`);

const checkColor = (color: string | null | undefined) =>
	color === null || color === undefined || HEX.test(color) ? Effect.void : fail(`${color} is not a #rrggbb color.`);

const checkName = (name: string) => (name.trim() === "" ? fail("A group needs a name.") : Effect.succeed(name.trim()));

const tracking = (append: Append, payload: SyncTracking) =>
	append({ topic: syncTopics.tracking, source: SOURCE, payload });

/** Tracking RPC handlers; `apps/server` is the only writer of the desktop columns. */
export const handlers = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const events = yield* Event.Service;

	const transact = <A>(
		body: (append: Append) => Effect.Effect<A, TrackingError | SqlError.SqlError, SqlClient.SqlClient>,
	) =>
		events
			.transact((append) => body(append).pipe(Effect.provideService(SqlClient.SqlClient, sql)))
			.pipe(Effect.catchTag("SqlError", Effect.die));

	/** Writes `fields` on a thread and announces them; `guard` narrows which row may take them. */
	const updateThread = (
		threadId: string,
		fields: Fields,
		append: Append,
		guard = sql.literal(""),
		notFound = `No thread ${threadId}.`,
	) =>
		Effect.gen(function* () {
			const rows = yield* sql`UPDATE thread SET ${sql.update(fields)} WHERE id = ${threadId} ${guard} RETURNING id`;
			if (rows.length === 0) return yield* fail(notFound);
			yield* tracking(append, { _tag: "Thread", threadId, ...fields });
		});

	/** The `ordering` that puts a row of `table` at `to` in its organization's list. */
	const place = (table: Ordering.Table, id: string, to: Position) =>
		Effect.gen(function* () {
			const [row] = yield* sql<{
				organizationId: string;
			}>`SELECT organization_id FROM ${sql(table)} WHERE id = ${id}`;
			if (row === undefined) return yield* missing(table, id);
			if (typeof to === "string") return yield* Ordering.edge(table, row.organizationId, to);
			const neighbours = yield* sql<{ id: string; ordering: number }>`
				SELECT id, ordering FROM ${sql(table)}
				WHERE organization_id = ${row.organizationId} AND id IN ${sql.in([to.after, to.before])}
			`;
			const after = neighbours.find((neighbour) => neighbour.id === to.after);
			const before = neighbours.find((neighbour) => neighbour.id === to.before);
			if (after === undefined) return yield* missing(`${table} in its organization`, to.after);
			if (before === undefined) return yield* missing(`${table} in its organization`, to.before);
			return Ordering.midpoint(after.ordering, before.ordering);
		});

	const groupRow = (rows: ReadonlyArray<Grouping>, id: string) =>
		rows[0] === undefined ? missing("group", id) : Effect.succeed(rows[0]);

	return {
		"threads.setStatus": Effect.fn("threads.setStatus")(function* ({
			threadId,
			status,
		}: {
			readonly threadId: string;
			readonly status: ThreadStatus;
		}) {
			yield* transact((append) =>
				Effect.gen(function* () {
					const [stored] = yield* sql<{ status: ThreadStatus }>`SELECT status FROM thread WHERE id = ${threadId}`;
					if (stored === undefined) return yield* missing("thread", threadId);
					if (stored.status === status) return;
					const at = yield* Clock.currentTimeMillis;
					yield* sql`UPDATE thread SET status = ${status}, status_at = ${at} WHERE id = ${threadId}`;
					const payload: SyncStatus = { threadId, status, previous: stored.status, at };
					yield* append({ topic: syncTopics.status, source: SOURCE, payload });
				}),
			);
		}),

		"threads.setPriority": Effect.fn("threads.setPriority")(function* ({
			threadId,
			priority,
		}: {
			readonly threadId: string;
			readonly priority: number;
		}) {
			if (!isPriority(priority)) return yield* fail(`${priority} is not a priority: 0 none, 1 urgent to 4 low.`);
			yield* transact((append) => updateThread(threadId, { priority }, append));
		}),

		"threads.setColor": Effect.fn("threads.setColor")(function* ({
			threadId,
			color,
		}: {
			readonly threadId: string;
			readonly color: string | null;
		}) {
			yield* checkColor(color);
			yield* transact((append) => updateThread(threadId, { color }, append));
		}),

		"threads.setGroup": Effect.fn("threads.setGroup")(function* ({
			threadId,
			groupingId,
		}: {
			readonly threadId: string;
			readonly groupingId: string | null;
		}) {
			// Only a group of the thread's own organization takes it.
			const guard =
				groupingId === null
					? sql.literal("")
					: sql`AND EXISTS (SELECT 1 FROM grouping WHERE grouping.id = ${groupingId} AND grouping.organization_id = thread.organization_id)`;
			const notFound =
				groupingId === null
					? `No thread ${threadId}.`
					: `No thread ${threadId} with a group ${groupingId} in its organization.`;
			yield* transact((append) => updateThread(threadId, { groupingId }, append, guard, notFound));
		}),

		"threads.move": Effect.fn("threads.move")(function* ({
			threadId,
			to,
		}: {
			readonly threadId: string;
			readonly to: Position;
		}) {
			yield* transact((append) =>
				Effect.gen(function* () {
					yield* updateThread(threadId, { ordering: yield* place("thread", threadId, to) }, append);
				}),
			);
		}),

		"sessions.setColor": Effect.fn("sessions.setColor")(function* ({
			sessionId,
			color,
		}: {
			readonly sessionId: string;
			readonly color: string | null;
		}) {
			yield* checkColor(color);
			yield* transact((append) =>
				Effect.gen(function* () {
					const rows = yield* sql`UPDATE session SET color = ${color} WHERE id = ${sessionId} RETURNING id`;
					if (rows.length === 0) return yield* missing("session", sessionId);
					yield* tracking(append, { _tag: "Session", sessionId, color });
				}),
			);
		}),

		"groups.create": Effect.fn("groups.create")(function* ({
			organizationId,
			name,
			color = null,
		}: {
			readonly organizationId: string;
			readonly name: string;
			readonly color?: string | null;
		}) {
			const trimmed = yield* checkName(name);
			yield* checkColor(color);
			return yield* transact((append) =>
				Effect.gen(function* () {
					const id = crypto.randomUUID();
					const now = yield* Clock.currentTimeMillis;
					const ordering = yield* Ordering.edge("grouping", organizationId, "last");
					// Selected from the organization, so a missing one inserts nothing.
					const [group] = yield* sql<Grouping>`
						INSERT INTO grouping (id, organization_id, name, color, ordering, created_at, updated_at)
						SELECT ${id}, id, ${trimmed}, ${color}, ${ordering}, ${now}, ${now} FROM organization WHERE id = ${organizationId}
						RETURNING id, organization_id, name, color, ordering
					`;
					if (group === undefined) return yield* missing("organization", organizationId);
					yield* tracking(append, { _tag: "Group", ...group });
					return group;
				}),
			);
		}),

		"groups.update": Effect.fn("groups.update")(function* ({
			groupingId,
			name,
			color,
		}: {
			readonly groupingId: string;
			readonly name?: string;
			readonly color?: string | null;
		}) {
			const fields = {
				...(name === undefined ? {} : { name: yield* checkName(name) }),
				...(color === undefined ? {} : { color: yield* checkColor(color).pipe(Effect.as(color)) }),
			};
			yield* transact((append) =>
				Effect.gen(function* () {
					const updatedAt = yield* Clock.currentTimeMillis;
					const group = yield* groupRow(
						yield* sql<Grouping>`
							UPDATE grouping SET ${sql.update({ ...fields, updatedAt })} WHERE id = ${groupingId}
							RETURNING id, organization_id, name, color, ordering
						`,
						groupingId,
					);
					yield* tracking(append, { _tag: "Group", ...group });
				}),
			);
		}),

		"groups.move": Effect.fn("groups.move")(function* ({
			groupingId,
			to,
		}: {
			readonly groupingId: string;
			readonly to: Position;
		}) {
			yield* transact((append) =>
				Effect.gen(function* () {
					const ordering = yield* place("grouping", groupingId, to);
					const updatedAt = yield* Clock.currentTimeMillis;
					const group = yield* groupRow(
						yield* sql<Grouping>`
							UPDATE grouping SET ordering = ${ordering}, updated_at = ${updatedAt} WHERE id = ${groupingId}
							RETURNING id, organization_id, name, color, ordering
						`,
						groupingId,
					);
					yield* tracking(append, { _tag: "Group", ...group });
				}),
			);
		}),

		"groups.delete": Effect.fn("groups.delete")(function* ({ groupingId }: { readonly groupingId: string }) {
			yield* transact((append) =>
				Effect.gen(function* () {
					// Named before the delete, whose foreign key ungroups them.
					const threads = yield* sql<{ id: string }>`SELECT id FROM thread WHERE grouping_id = ${groupingId}`;
					const rows = yield* sql`DELETE FROM grouping WHERE id = ${groupingId} RETURNING id`;
					if (rows.length === 0) return yield* missing("group", groupingId);
					yield* tracking(append, {
						_tag: "GroupDeleted",
						groupingId,
						threads: threads.map((thread) => thread.id),
					});
				}),
			);
		}),
	};
});

export * as Tracking from "./tracking.ts";
