import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import {
	type LineRequest,
	LineThread,
	type SidebarProject,
	type SidebarSession,
	SyncError,
	type ThreadLine,
} from "@codeworksh/contract";
import { HistoryEntry, Part, QueuedPrompt, RunError, UNTITLED } from "@codeworksh/widget/codework";

/*
 * What the UI reads from app.db: the sidebar and a thread's line. Neither calls CodeWork, so both
 * answer from the copy while a machine is away.
 */

/** A first page's bytes, as `thread.sync`'s. */
const BUDGET = 1 << 20;

const decodePart = Schema.decodeUnknownEffect(Schema.fromJsonString(Part));
const decodeRunError = Schema.decodeUnknownEffect(Schema.fromJsonString(RunError));
const decodeEntry = Schema.decodeUnknownEffect(HistoryEntry);
const decodePrompt = Schema.decodeUnknownEffect(QueuedPrompt);
const decodeThread = Schema.decodeUnknownEffect(LineThread);

const model = (provider: string | null, id: string | null) =>
	provider === null || id === null ? {} : { model: { provider, id } };

/** The machine filter of `sidebar.list`. */
const onMachines = (sql: SqlClient.SqlClient, machines: "default" | "all") =>
	machines === "all" ? sql.literal("") : sql`AND machine.is_default = 1`;

export const sidebar = Effect.fn("Reads.sidebar")(function* ({
	organizationId,
	machines,
}: {
	readonly organizationId: string;
	readonly machines: "default" | "all";
}) {
	const sql = yield* SqlClient.SqlClient;
	const projects = yield* sql<{
		machineId: string;
		machineName: string;
		id: string;
		name: string;
		location: string | null;
		updatedAt: number;
	}>`
		SELECT project.machine_id, machine.name AS machine_name, project.id, project.name, project.updated_at,
			(SELECT location FROM space WHERE space.machine_id = project.machine_id AND space.project_id = project.id
				ORDER BY space.kind = 'primary' DESC, space.created_at LIMIT 1) AS location
		FROM project JOIN machine ON machine.id = project.machine_id
		WHERE project.organization_id = ${organizationId} AND project.status = 'active' ${onMachines(sql, machines)}
		ORDER BY project.updated_at DESC
	`;
	const sessions = yield* sql<{
		id: string;
		machineId: string;
		projectId: string;
		spaceKind: SidebarSession["spaceKind"];
		color: string | null;
		dir: string;
		hostdir: string | null;
		threadId: string;
		title: string | null;
		modelProvider: string | null;
		modelId: string | null;
		runState: SidebarSession["runState"];
		updatedAt: number;
	}>`
		SELECT session.id, session.machine_id, space.project_id, space.kind AS space_kind, session.color,
			session.dir, session.hostdir, thread.id AS thread_id, thread.title, thread.model_provider,
			thread.model_id, thread.run_state, thread.updated_at
		FROM session
		JOIN space ON space.machine_id = session.machine_id AND space.id = session.space_id
		JOIN thread ON thread.session_id = session.id AND thread.origin_kind = 'main' AND thread.deleted_at IS NULL
		JOIN machine ON machine.id = session.machine_id
		WHERE session.organization_id = ${organizationId} AND session.deleted_at IS NULL ${onMachines(sql, machines)}
		ORDER BY thread.updated_at DESC
	`;
	const byProject = new Map<string, Array<SidebarSession>>();
	for (const row of sessions) {
		const key = `${row.machineId}/${row.projectId}`;
		const list = byProject.get(key) ?? [];
		list.push({
			id: row.id,
			threadId: row.threadId,
			spaceKind: row.spaceKind,
			color: row.color,
			title: row.title ?? UNTITLED,
			...model(row.modelProvider, row.modelId),
			runState: row.runState,
			updated: row.updatedAt,
			path: row.hostdir ?? row.dir,
		});
		byProject.set(key, list);
	}
	const listed = projects.map((project): SidebarProject => {
		const list = byProject.get(`${project.machineId}/${project.id}`) ?? [];
		return {
			machine: { id: project.machineId, name: project.machineName },
			id: project.id,
			name: project.name,
			path: list[0]?.path ?? project.location ?? project.name,
			sessions: list,
		};
	});
	// Newest activity first; a project without sessions by its own last change.
	const activity = (project: SidebarProject) => project.sessions[0]?.updated ?? -1;
	return listed.toSorted((a, b) => activity(b) - activity(a));
}, Effect.orDie);

/**
 * A thread and the sources its line inherits from, as `(thread_id, upto, depth)`: each source's
 * entries count up to the cut of the thread forked from it, as the harness walks it.
 */
const walk = (sql: SqlClient.SqlClient, threadId: string) => sql`
	WITH RECURSIVE line(thread_id, upto, depth) AS (
		SELECT ${threadId}, NULL, 0
		UNION ALL
		SELECT thread.origin_thread_id, thread.origin_committed_seq, line.depth + 1
		FROM line JOIN thread ON thread.id = line.thread_id
		WHERE thread.origin_thread_id IS NOT NULL AND thread.origin_committed_seq IS NOT NULL
	)
`;

interface EntryRow {
	readonly id: string;
	readonly threadId: string;
	readonly seq: number;
	readonly type: string;
	readonly state: string;
	readonly error: string | null;
	readonly size: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}

const ENTRY_COLUMNS =
	"entry.id, entry.thread_id, entry.seq, entry.type, entry.state, entry.error, entry.size, entry.created_at, entry.updated_at";

/** Entry rows as the wire's entries, with their parts. */
const withParts = (rows: ReadonlyArray<EntryRow>) =>
	Effect.gen(function* () {
		if (rows.length === 0) return [];
		const sql = yield* SqlClient.SqlClient;
		const parts = yield* sql<{ entryId: string; data: string }>`
			SELECT entry_id, data FROM part WHERE entry_id IN ${sql.in(rows.map((row) => row.id))}
			ORDER BY entry_id, part_index
		`;
		const byEntry = new Map<string, Array<Part>>();
		for (const part of parts) {
			const list = byEntry.get(part.entryId) ?? [];
			list.push(yield* decodePart(part.data));
			byEntry.set(part.entryId, list);
		}
		return yield* Effect.forEach(rows, ({ type, error, ...row }) =>
			decodeEntry({
				...row,
				role: type,
				parts: byEntry.get(row.id) ?? [],
				...(error === null ? {} : { error }),
			}),
		);
	});

/** The stored entries with these ids, oldest first. */
export const entries = Effect.fn("Reads.entries")(function* (ids: ReadonlyArray<string>) {
	if (ids.length === 0) return [];
	const sql = yield* SqlClient.SqlClient;
	const rows = yield* sql<EntryRow>`
		SELECT ${sql.literal(ENTRY_COLUMNS)} FROM entry WHERE entry.id IN ${sql.in(ids)} ORDER BY entry.seq
	`;
	return yield* withParts(rows);
}, Effect.orDie);

const head = (sql: SqlClient.SqlClient, { sessionId, threadId }: LineRequest) =>
	sql<{
		id: string;
		sessionId: string;
		machineId: string;
		title: string | null;
		modelProvider: string | null;
		modelId: string | null;
		thinkingLevel: string | null;
		runState: string;
		runStartedAt: number | null;
		runEndedAt: number | null;
		runOutcome: string | null;
		runError: string | null;
		updatedAt: number;
		floor: number | null;
		dir: string;
		hostdir: string | null;
		projectId: string;
		projectName: string;
	}>`
		SELECT thread.id, thread.session_id, session.machine_id, thread.title, thread.model_provider, thread.model_id,
			thread.thinking_level, thread.run_state, thread.run_started_at, thread.run_ended_at, thread.run_outcome,
			thread.run_error, thread.updated_at, thread.floor, session.dir, session.hostdir,
			project.id AS project_id, project.name AS project_name
		FROM thread
		JOIN session ON session.id = thread.session_id
		JOIN space ON space.machine_id = session.machine_id AND space.id = session.space_id
		JOIN project ON project.machine_id = space.machine_id AND project.id = space.project_id
		WHERE thread.session_id = ${sessionId} AND thread.deleted_at IS NULL AND session.deleted_at IS NULL
			AND ${threadId === undefined ? sql`thread.origin_kind = 'main'` : sql`thread.id = ${threadId}`}
	`;

export const line = Effect.fn("Reads.line")(function* (request: LineRequest) {
	const sql = yield* SqlClient.SqlClient;
	const [row] = yield* head(sql, request).pipe(Effect.orDie);
	if (row === undefined)
		return yield* new SyncError({
			message: `No thread ${request.threadId ?? "(main)"} of session ${request.sessionId} is synced.`,
		});
	return yield* Effect.gen(function* () {
		const lineOf = walk(sql, row.id);
		const [titled] =
			row.title === null
				? yield* sql<{ title: string }>`
					${lineOf}
					SELECT thread.title FROM line JOIN thread ON thread.id = line.thread_id
					WHERE thread.title IS NOT NULL ORDER BY line.depth LIMIT 1
				`
				: [{ title: row.title }];
		const { before, limit, budget = BUDGET } = request;
		// The budget is a running total over the newest `limit` entries, so it reads no further; the newest always counts.
		const page =
			limit <= 0
				? []
				: yield* sql<EntryRow>`
					SELECT id, thread_id, seq, type, state, error, size, created_at, updated_at FROM (
						SELECT *, SUM(size) OVER newest AS total, ROW_NUMBER() OVER newest AS n FROM (
							${lineOf}
							SELECT ${sql.literal(ENTRY_COLUMNS)}
							FROM line JOIN entry ON entry.thread_id = line.thread_id
								AND (line.upto IS NULL OR entry.seq <= line.upto)
							${before === undefined ? sql.literal("") : sql`WHERE entry.seq < ${before}`}
							ORDER BY entry.seq DESC LIMIT ${limit}
						)
						WINDOW newest AS (ORDER BY seq DESC)
					)
					WHERE n = 1 OR total <= ${budget}
					ORDER BY seq
				`;
		const below = page[0]?.seq ?? before;
		const [older] =
			below === undefined
				? [{ found: 0 }]
				: yield* sql<{ found: number }>`
					${lineOf}
					SELECT EXISTS (
						SELECT 1 FROM line JOIN entry ON entry.thread_id = line.thread_id
							AND (line.upto IS NULL OR entry.seq <= line.upto)
						WHERE entry.seq < ${below}
					) AS found
				`;
		const inbox = yield* sql<{
			id: string;
			delivery: string;
			text: string;
			admittedSeq: number;
			createdAt: number;
		}>`SELECT id, delivery, text, admitted_seq, created_at FROM inbox WHERE thread_id = ${row.id} ORDER BY admitted_seq`;
		const lastRun =
			row.runStartedAt === null
				? {}
				: {
						lastRun: {
							startedAt: row.runStartedAt,
							...(row.runEndedAt === null ? {} : { endedAt: row.runEndedAt }),
							...(row.runOutcome === null ? {} : { outcome: row.runOutcome }),
							...(row.runError === null ? {} : { error: yield* decodeRunError(row.runError) }),
						},
					};
		const thread = yield* decodeThread({
			id: row.id,
			sessionId: row.sessionId,
			machineId: row.machineId,
			...(titled === undefined ? {} : { title: titled.title }),
			...model(row.modelProvider, row.modelId),
			...(row.thinkingLevel === null ? {} : { thinkingLevel: row.thinkingLevel }),
			runState: row.runState,
			...lastRun,
			updatedAt: row.updatedAt,
			directory: row.dir,
			...(row.hostdir === null ? {} : { hostDir: row.hostdir }),
			project: { id: row.projectId, name: row.projectName },
		});
		return {
			thread,
			entries: yield* withParts(page),
			inbox: yield* Effect.forEach(inbox, (prompt) => decodePrompt(prompt)),
			more: older !== undefined && older.found === 1,
			floor: row.floor,
		} satisfies ThreadLine;
	}).pipe(Effect.orDie);
});

export * as Reads from "./reads.ts";
