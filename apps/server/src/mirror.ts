import { Effect, String as Str } from "effect";
import { SqlClient } from "effect/sql";
import type { Publish } from "@codeworksh/widget/event";
import type { Codework } from "@codeworksh/widget/codework";
import { Ordering } from "./ordering.ts";
import { syncTopics, type SyncChanged, type SyncStatus, type ThreadStatus } from "@codeworksh/contract";

/*
 * The writes that copy a machine's CodeWork rows into app.db. Each runs inside the caller's
 * transaction; core columns come from the rows, desktop columns are set once, on insert.
 */

type IndexRow = Exclude<Codework.IndexItem, { _tag: "Synced" }>;
type ThreadRow = Exclude<Codework.ThreadItem, { _tag: "Synced" }>;
type Append = (input: Publish) => Effect.Effect<void>;

/** The organization every project starts in, until auth exists. */
const ORGANIZATION = "personal";

/** The rows a batch wrote, for its `SyncChanged` notice. */
export class Changes {
	readonly project = new Set<string>();
	readonly space = new Set<string>();
	readonly session = new Set<string>();
	readonly thread = new Set<string>();
	readonly entry = new Set<string>();
	readonly inbox = new Set<string>();
	readonly removed = new Set<string>();

	notice(input: { machineId: string; threadId?: string; full: boolean; items: number }): SyncChanged {
		return {
			...input,
			project: [...this.project],
			space: [...this.space],
			session: [...this.session],
			thread: [...this.thread],
			entry: [...this.entry],
			inbox: [...this.inbox],
			removed: [...this.removed],
		};
	}
}

/** Inserts `core` and `created`, or updates only `core` when the row at `keys` exists. */
const upsert = (table: string, keys: ReadonlyArray<string>, core: Record<string, unknown>, created = {}) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const set = Object.keys(core)
			.map(Str.camelToSnake)
			.filter((column) => !keys.includes(column))
			.map((column) => `${column} = excluded.${column}`)
			.join(", ");
		yield* sql`
			INSERT INTO ${sql(table)} ${sql.insert({ ...core, ...created })}
			ON CONFLICT (${sql.literal(keys.join(", "))}) DO UPDATE SET ${sql.literal(set)}
		`;
	});

/** The organization of the row `query` finds, else the one every project starts in. */
const organizationOf = (query: Effect.Effect<ReadonlyArray<{ organizationId: string }>, unknown>) =>
	query.pipe(Effect.map((rows) => rows[0]?.organizationId ?? ORGANIZATION));

/** Where a thread goes when its run moves, by the incoming row against the stored one (section 5 of the design). */
const moved = (
	stored: { readonly runStartedAt: number | null; readonly runEndedAt: number | null },
	thread: Codework.ThreadSummary,
): ThreadStatus | undefined => {
	const run = thread.lastRun;
	if (run === undefined) return undefined;
	if (run.startedAt !== stored.runStartedAt && thread.runState !== "idle") return "working";
	if (run.endedAt === undefined || run.endedAt === stored.runEndedAt) return undefined;
	if (run.outcome === "succeeded" || run.outcome === "failed") return "attention";
	if (run.error?._tag === "interrupted" && run.error.reason === "user") return "cancelled";
	// Shutdown or crash: a resume or a `run.failed` follows and decides.
	return undefined;
};

const firstSeen = (thread: Codework.ThreadSummary): ThreadStatus =>
	thread.runState !== "idle" ? "working" : thread.lastRun?.outcome === "failed" ? "attention" : "settled";

const threadCore = (thread: Codework.ThreadSummary) => {
	const origin = thread.origin;
	const run = thread.lastRun;
	return {
		sessionId: thread.sessionId,
		originKind: origin.kind,
		originThreadId: origin.kind === "main" ? null : origin.threadId,
		originEntryId: origin.kind === "main" ? null : (origin.entryId ?? null),
		originCallId: origin.kind === "subagent" ? origin.callId : null,
		originCommittedSeq: origin.kind === "main" ? null : (origin.cut ?? null),
		title: thread.title ?? null,
		modelProvider: thread.model?.provider ?? null,
		modelId: thread.model?.id ?? null,
		thinkingLevel: thread.thinkingLevel ?? null,
		foundation: thread.foundation ?? null,
		placementSpaceId: thread.placement?.spaceId ?? null,
		placementDir: thread.placement?.directory ?? null,
		restarts: thread.restarts,
		attempt: thread.attempt ?? null,
		runState: thread.runState,
		runStateAt: thread.runStateAt ?? null,
		runStartedAt: run?.startedAt ?? null,
		runEndedAt: run?.endedAt ?? null,
		runOutcome: run?.outcome ?? null,
		runError: run?.error === undefined ? null : JSON.stringify(run.error),
		cost: thread.usage.cost,
		tokensInput: thread.usage.input,
		tokensOutput: thread.usage.output,
		tokensCacheRead: thread.usage.cacheRead,
		tokensCacheWrite: thread.usage.cacheWrite,
		createdSeq: thread.createdSeq,
		createdAt: thread.createdAt,
		updatedAt: thread.updatedAt,
		// The store has the row, so a soft delete from an earlier full sync (a restored store) is undone.
		deletedAt: null,
	};
};

const storeThread = (thread: Codework.ThreadSummary, now: number, append: Append) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const core = threadCore(thread);
		const [stored] = yield* sql<{ status: ThreadStatus; runStartedAt: number | null; runEndedAt: number | null }>`
			SELECT status, run_started_at, run_ended_at FROM thread WHERE id = ${thread.id}
		`;
		if (stored === undefined) {
			const organizationId = yield* organizationOf(
				sql`SELECT organization_id FROM session WHERE id = ${thread.sessionId}`,
			);
			yield* sql`INSERT INTO thread ${sql.insert({
				id: thread.id,
				...core,
				organizationId,
				status: firstSeen(thread),
				statusAt: now,
				priority: 0,
				ordering: yield* Ordering.edge("thread", organizationId, "first"),
			})}`;
			return;
		}
		yield* sql`UPDATE thread SET ${sql.update(core)} WHERE id = ${thread.id}`;
		const status = moved(stored, thread);
		if (status === undefined || status === stored.status) return;
		yield* sql`UPDATE thread SET status = ${status}, status_at = ${now} WHERE id = ${thread.id}`;
		const payload: SyncStatus = { threadId: thread.id, status, previous: stored.status, at: now };
		yield* append({ topic: syncTopics.status, source: "sync", payload });
	});

/** Applies one `index.sync` batch of a machine's rows. */
export const index = (
	machine: { readonly id: string; readonly namespace: string },
	rows: ReadonlyArray<IndexRow>,
	now: number,
	append: Append,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const changes = new Changes();
		for (const row of rows) {
			switch (row._tag) {
				case "Project": {
					const { project } = row;
					yield* upsert(
						"project",
						["machine_id", "id"],
						{
							machineId: machine.id,
							id: project.id,
							namespace: machine.namespace,
							name: project.name,
							status: project.status,
							createdAt: project.createdAt,
							updatedAt: project.updatedAt,
						},
						{ organizationId: ORGANIZATION },
					);
					changes.project.add(project.id);
					break;
				}
				case "Space": {
					const { space } = row;
					const organizationId = yield* organizationOf(
						sql`SELECT organization_id FROM project WHERE machine_id = ${machine.id} AND id = ${space.projectId}`,
					);
					yield* upsert(
						"space",
						["machine_id", "id"],
						{
							machineId: machine.id,
							id: space.id,
							projectId: space.projectId,
							location: space.location,
							kind: space.kind,
							env: space.env ?? null,
							status: space.status,
							createdAt: space.createdAt,
							updatedAt: space.updatedAt,
						},
						{ organizationId },
					);
					changes.space.add(space.id);
					break;
				}
				case "Session": {
					const { session } = row;
					const organizationId = yield* organizationOf(
						sql`SELECT organization_id FROM space WHERE machine_id = ${machine.id} AND id = ${session.spaceId}`,
					);
					yield* upsert(
						"session",
						["id"],
						{
							id: session.id,
							machineId: machine.id,
							spaceId: session.spaceId,
							slug: session.slug,
							dir: session.directory,
							hostdir: session.hostDir ?? null,
							tag: session.tag ?? null,
							metadata: session.metadata === undefined ? null : JSON.stringify(session.metadata),
							createdAt: session.createdAt,
							updatedAt: session.updatedAt,
							deletedAt: null,
						},
						{ organizationId },
					);
					changes.session.add(session.id);
					break;
				}
				case "Thread":
					yield* storeThread(row.thread, now, append);
					changes.thread.add(row.thread.id);
					break;
				case "Removed":
					yield* sql`UPDATE session SET deleted_at = ${now} WHERE id = ${row.id} AND deleted_at IS NULL`;
					yield* sql`UPDATE thread SET deleted_at = ${now} WHERE session_id = ${row.id} AND deleted_at IS NULL`;
					changes.removed.add(row.id);
					break;
			}
		}
		return changes;
	});

/**
 * Ends a full sync's first batch: the machine's sessions and threads it did not send are gone from
 * the store, and every thread's detail starts over from a first open.
 */
export const unseen = (machineId: string, seen: Changes, now: number) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const sessions = [...seen.session];
		const threads = [...seen.thread];
		const gone = yield* sql<{ id: string }>`
			SELECT id FROM session WHERE machine_id = ${machineId} AND deleted_at IS NULL
			${sessions.length === 0 ? sql.literal("") : sql`AND id NOT IN ${sql.in(sessions)}`}
		`;
		for (const { id } of gone) seen.removed.add(id);
		yield* sql`
			UPDATE session SET deleted_at = ${now} WHERE machine_id = ${machineId} AND deleted_at IS NULL
			${sessions.length === 0 ? sql.literal("") : sql`AND id NOT IN ${sql.in(sessions)}`}
		`;
		yield* sql`
			UPDATE thread SET deleted_at = ${now}
			WHERE deleted_at IS NULL AND session_id IN (SELECT id FROM session WHERE machine_id = ${machineId})
			${threads.length === 0 ? sql.literal("") : sql`AND id NOT IN ${sql.in(threads)}`}
		`;
		yield* sql`
			UPDATE thread SET cursor = NULL WHERE session_id IN (SELECT id FROM session WHERE machine_id = ${machineId})
		`;
	});

/** Stores entries of a thread's line, each under the thread that wrote it, with its parts. */
export const entries = (list: ReadonlyArray<Codework.HistoryEntry>, changes: Changes) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		for (const entry of list) {
			yield* upsert("entry", ["id"], {
				id: entry.id,
				threadId: entry.threadId,
				seq: entry.seq,
				type: entry.role,
				state: entry.state,
				error: entry.error ?? null,
				size: entry.size,
				createdAt: entry.createdAt,
				updatedAt: entry.updatedAt,
			});
			yield* sql`DELETE FROM part WHERE entry_id = ${entry.id}`;
			if (entry.parts.length > 0)
				yield* sql`INSERT INTO part ${sql.insert(
					entry.parts.map((part, partIndex) => ({
						entryId: entry.id,
						partIndex,
						type: part.type,
						status: part.type === "toolCall" ? part.status : null,
						callId: part.type === "toolCall" ? part.callID : null,
						toolName: part.type === "toolCall" ? part.name : null,
						data: JSON.stringify(part),
					})),
				)}`;
			changes.entry.add(entry.id);
		}
	});

/** Applies one `thread.sync` batch of a thread's rows; deltas are never stored. */
export const thread = (threadId: string, rows: ReadonlyArray<ThreadRow>) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const changes = new Changes();
		yield* entries(
			rows.flatMap((row) => (row._tag === "Entry" ? [row.entry] : [])),
			changes,
		);
		for (const row of rows) {
			if (row._tag !== "Inbox") continue;
			const { prompt } = row;
			if (row.state === "pending")
				yield* upsert("inbox", ["id"], {
					id: prompt.id,
					threadId,
					delivery: prompt.delivery,
					text: prompt.text,
					admittedSeq: prompt.admittedSeq,
					createdAt: prompt.createdAt,
				});
			else yield* sql`DELETE FROM inbox WHERE id = ${prompt.id}`;
			changes.inbox.add(row.prompt.id);
		}
		return changes;
	});

export * as Mirror from "./mirror.ts";
