import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema, type Statement } from "effect/sql";
import { uuidv7 } from "uuidv7";
import {
	EntryPartRow,
	EntryRow,
	type EntryState,
	type EntryType,
	messageEntryTypes,
	type PartType,
	ThreadRow,
	type ToolStatus,
} from "../db/schema.sql.ts";
import { Store } from "../db/store.ts";
import { NonNegativeInt } from "../schema.ts";
import { Document } from "../document/document.ts";
import { DocumentSchema } from "../document/schema.ts";
import { Event } from "../event/event.ts";
import { EventList } from "../event/list.ts";
import { SessionSchema } from "../session/schema.ts";
import { ThreadSchema } from "./schema.ts";

export class ThreadNotFoundError extends Schema.TaggedError<ThreadNotFoundError>()("ThreadNotFoundError", {
	threadId: Schema.String,
}) {
	override get message(): string {
		return `thread ${this.threadId} not found`;
	}
}

export class EntryNotFoundError extends Schema.TaggedError<EntryNotFoundError>()("EntryNotFoundError", {
	threadId: Schema.String,
	entryId: Schema.String,
}) {}

// Structural rejection — the data-structure layer's "index out of bounds".
export class InvalidEntryDataError extends Schema.TaggedError<InvalidEntryDataError>()("InvalidEntryDataError", {
	entryId: Schema.String,
	type: Schema.String,
	reason: Schema.String,
}) {}

/** A fork point the thread's line cannot be cut at. */
export class ForkError extends Schema.TaggedError<ForkError>()("ForkError", {
	threadId: Schema.String,
	entryId: Schema.String,
	reason: Schema.Literals([
		// not in the thread's line
		"entry_not_found",
		// a draft is still changing, an aborted entry is not part of the context
		"entry_not_committed",
		// `before` refills the editor, so it needs a user entry
		"not_a_user_entry",
		// `before` the first entry of main: an empty start is a new session or a reset
		"nothing_before_entry",
	]),
}) {
	override get message(): string {
		return `cannot fork ${this.threadId} at ${this.entryId}: ${this.reason.replaceAll("_", " ")}`;
	}
}

export interface AppendPart {
	readonly id?: string; // uuidv7; generated when omitted
	readonly type: PartType;
	readonly status?: ToolStatus; // toolCall parts only
	readonly callId?: string; // toolCall parts only
	readonly toolName?: string; // toolCall parts only
	readonly data: string; // verbatim aikit part JSON
}

export interface AppendEntry {
	readonly id: string; // uuidv7; == aikit messageId for message types
	readonly threadId: ThreadSchema.ID;
	/** The sequence of the event that produced this entry. Must exceed every own entry's seq. */
	readonly seq: number;
	readonly type: EntryType;
	/** Defaults to committed. Only LLMStarted inserts a draft. */
	readonly state?: EntryState;
	readonly data: string; // JSON: full payload, or message envelope
	readonly parts?: ReadonlyArray<AppendPart>; // order = partIndex; message types only
	/**
	 * Publish-time context from the event that produced this entry. The log does
	 * not store event metadata, so if it is to survive at all it survives here.
	 */
	readonly metadata?: Readonly<Record<string, string>>;
}

export interface SettleToolCall {
	readonly entryId: string; // owning assistant entry
	readonly callId: string;
	readonly status: Exclude<ToolStatus, "pending" | "running">;
	readonly data: string; // settled aikit part JSON, verbatim
}

export interface ReplaceAssistant {
	readonly id: string;
	readonly threadId: ThreadSchema.ID;
	readonly data: string;
	readonly parts: ReadonlyArray<AppendPart>;
}

/** Ends a draft assistant: committed once every tool part is settled, or aborted. */
export interface EndAssistant {
	readonly id: string;
	readonly threadId: ThreadSchema.ID;
	/** The event that ends it; becomes its `committedSeq`. */
	readonly seq: number;
}

/** One part change of a streaming draft: `append` extends a text or thinking part, `set` writes one whole. */
export type ProgressChange =
	| { readonly _tag: "append"; readonly partIndex: number; readonly text: string }
	| { readonly _tag: "set"; readonly partIndex: number; readonly part: AppendPart };

export interface ProgressAssistant {
	readonly id: string;
	readonly threadId: ThreadSchema.ID;
	readonly changes: ReadonlyArray<ProgressChange>;
}

export interface ForkInput {
	readonly threadId: ThreadSchema.ID;
	readonly entryId: string;
	/** `at` keeps the entry; `before` stops at its predecessor (user entries only). Default `at`. */
	readonly mode?: "at" | "before";
	readonly id?: ThreadSchema.ID;
}

export interface Forked {
	readonly thread: ThreadRow;
	/** For `before`: the text of the user entry left out, to refill the editor with. */
	readonly text?: string;
}

/** What a projector inserts for a new thread; usage and run state start empty. */
export interface InsertThread {
	readonly id: ThreadSchema.ID;
	readonly sessionId: SessionSchema.ID;
	readonly origin: ThreadSchema.Origin;
	readonly title?: string;
	readonly seq: number;
}

/** One step of a thread's run lifecycle, from the event that projects it. */
export type RunChange =
	| { readonly _tag: "started" }
	| { readonly _tag: "running" }
	| {
			readonly _tag: "ended";
			readonly outcome: ThreadSchema.RunOutcome;
			readonly error?: ThreadSchema.RunError;
			/** The ending event's seq. */
			readonly seq: number;
	  };

// Entry row + its part rows, zipped. Message decode happens above this layer.
export interface HydratedEntry {
	readonly entry: EntryRow;
	readonly parts: ReadonlyArray<EntryPartRow>;
	/** Bytes of its parts' stored `data`. */
	readonly size: number;
}

export interface LinePageInput {
	readonly threadId: ThreadSchema.ID;
	/** Only entries with a lower seq; absent starts at the newest. */
	readonly before?: number;
	/** Bytes by `size`; the newest entry is always read, whatever its size. */
	readonly budget: number;
	readonly limit: number;
}

export interface Interface {
	readonly get: (threadId: string) => Effect.Effect<Option.Option<ThreadRow>>;
	/** The session's main thread; none when the session is unknown. */
	readonly main: (sessionId: string) => Effect.Effect<Option.Option<ThreadRow>>;
	/** Threads newest first: of one session, or of the whole database. */
	readonly list: (sessionId?: SessionSchema.ID) => Effect.Effect<ReadonlyArray<ThreadRow>>;
	readonly entry: (entryId: string) => Effect.Effect<Option.Option<HydratedEntry>>;
	/** Where the thread's inherited line ends: its origin entry's committed seq; none when it inherits nothing. */
	readonly cut: (threadId: string) => Effect.Effect<Option.Option<number>>;
	/**
	 * The thread's line: its own entries, then its source's through the fork entry, recursively, in
	 * seq order. Every state is included; context assembly drops what is not committed.
	 */
	readonly line: (threadId: ThreadSchema.ID) => Effect.Effect<ReadonlyArray<HydratedEntry>>;
	/**
	 * One page of the conversation in the thread's line (user and assistant entries, inherited ones
	 * included), newest first: past `before`, up to `limit` entries, stopping once `budget` bytes
	 * are spent.
	 */
	readonly linePage: (input: LinePageInput) => Effect.Effect<ReadonlyArray<HydratedEntry>>;
	/** The thread's open draft, if a run left one. */
	readonly draft: (threadId: ThreadSchema.ID) => Effect.Effect<Option.Option<HydratedEntry>>;
	/** Unsettled toolCall parts of the thread's own entries (crash recovery / live status). */
	readonly unsettled: (threadId: ThreadSchema.ID) => Effect.Effect<ReadonlyArray<EntryPartRow>>;
	/** Projector-only: a new thread row. */
	readonly insert: (input: InsertThread) => Effect.Effect<void>;
	readonly append: (
		input: AppendEntry,
	) => Effect.Effect<EntryRow, ThreadNotFoundError | EntryNotFoundError | InvalidEntryDataError>;
	/** Projector-only: replace the payload of an existing draft assistant in place. */
	readonly replaceAssistant: (input: ReplaceAssistant) => Effect.Effect<void>;
	/** Projector-only: apply a streaming checkpoint to a draft assistant's parts. */
	readonly progress: (input: ProgressAssistant) => Effect.Effect<void>;
	/** Projector-only: settle one pending/running tool part on a draft assistant. */
	readonly settleToolCall: (input: SettleToolCall) => Effect.Effect<void>;
	/** Projector-only: commit a draft after every tool part is terminal. */
	readonly commit: (input: EndAssistant) => Effect.Effect<void>;
	/** Projector-only: end a draft as aborted with the payload and parts given. */
	readonly abort: (input: ReplaceAssistant & EndAssistant) => Effect.Effect<void>;
	/** Cut a new thread off `threadId`'s line at a committed entry. */
	readonly fork: (input: ForkInput) => Effect.Effect<Forked, ThreadNotFoundError | ForkError>;
	/** Projector of `session.thread.forked`: the thread and its copied documents, at the event's seq. */
	readonly projectForked: (input: EventList.ThreadForked["data"], seq: number) => Effect.Effect<void>;
	/** Names an untitled thread. Returns whether the title changed. */
	readonly retitle: (threadId: ThreadSchema.ID, title: string) => Effect.Effect<boolean>;
	/**
	 * Claims a thread's unfinished run for recovery, counting a restart when the sweep found its host
	 * dead in it, unless the run slept in retry backoff (a shutdown is not counted either). The new count,
	 * or none when nothing is unfinished any more, say because the user stopped it since.
	 */
	readonly claimRestart: (threadId: ThreadSchema.ID) => Effect.Effect<Option.Option<number>>;
	/** A committed turn is progress: the restart count starts over. Runs inside `TurnEnded`'s commit. */
	readonly resetRestarts: (threadId: ThreadSchema.ID) => Effect.Effect<void>;
	/** Records the 1-based provider request now in flight, or none (null) once its response ended. */
	readonly setAttempt: (threadId: ThreadSchema.ID, attempt: number | null) => Effect.Effect<void>;
	/** Whether a pending prompt of the thread is past its head: woken since its last unanswered end. */
	readonly runnable: (threadId: ThreadSchema.ID) => Effect.Effect<boolean>;
	/** Whether the thread is among {@link unfinished}: still owed a resume, say not stopped since. */
	readonly resumable: (threadId: ThreadSchema.ID) => Effect.Effect<boolean>;
	/** Whether the thread's last run was cut off by the host, a crash or a shutdown: a run to resume. */
	readonly cutOff: (threadId: ThreadSchema.ID) => Effect.Effect<boolean>;
	/**
	 * Threads with a run left to resume, oldest first: their last run was interrupted by a crash or a
	 * shutdown, or a pending prompt is runnable. Read after the startup sweep has closed open runs.
	 */
	readonly unfinished: Effect.Effect<ReadonlyArray<ThreadRow>>;
	/**
	 * Projector-only: the `run_*` columns, at the time `at` of the event that changed them, and what a
	 * run's end settles: `head` moves to an unanswered end (a failure or a user stop), which parks the
	 * queue; the restart count and the request in flight clear, except where the run resumes. An end
	 * landing on a run already ended only moves `head`. Dies when the thread is gone, rolling the event back.
	 */
	readonly projectRun: (threadId: ThreadSchema.ID, at: DateTime.Utc, change: RunChange) => Effect.Effect<void>;
	/** Threads whose stored run is not idle: at startup, the runs a dead process left open. */
	readonly open: Effect.Effect<ReadonlyArray<ThreadRow>>;
	/** Set or clear (null) the bookmark label on an entry of the thread. */
	readonly setLabel: (input: {
		threadId: ThreadSchema.ID;
		entryId: string;
		label: string | null;
	}) => Effect.Effect<void, EntryNotFoundError>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/thread/thread/Service") {}

const messageTypes: ReadonlySet<string> = new Set(messageEntryTypes);

const SizedEntryRow = Schema.Struct({ ...EntryRow.fields, size: NonNegativeInt });
type SizedEntryRow = typeof SizedEntryRow.Type;

// Structural decode of the persisted envelope's usage; failures surface as
// InvalidEntryDataError, never a defect — callers (Context Manager, UI) can act.
const decodeEnvelopeUsage = Schema.decodeUnknownEffect(SessionSchema.AssistantEnvelopeUsage);
const decodeMessageEnvelopeIdentity = Schema.decodeUnknownEffect(SessionSchema.MessageEnvelopeIdentity);
const decodeCompactionData = Schema.decodeUnknownEffect(SessionSchema.CompactionData);
const decodeJsonObject = Schema.decodeUnknownEffect(SessionSchema.JsonObject);
const encodeJsonObject = Schema.encodeEffect(SessionSchema.JsonObject);
const encodeRunError = Schema.encodeEffect(Schema.fromJsonString(ThreadSchema.RunError));
const decodeUserText = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
);

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const store = yield* Store.Service;
		const events = yield* Event.Service;
		const documents = yield* Document.Service;

		const findThread = SqlSchema.findOneOption({
			Request: Schema.String,
			Result: ThreadRow,
			execute: (id) => sql`SELECT * FROM thread WHERE id = ${id}`,
		});

		const findMain = SqlSchema.findOneOption({
			Request: Schema.String,
			Result: ThreadRow,
			execute: (sessionId) => sql`SELECT * FROM thread WHERE session_id = ${sessionId} AND origin_kind = 'main'`,
		});

		const selectBySession = SqlSchema.findAll({
			Request: Schema.String,
			Result: ThreadRow,
			execute: (sessionId) => sql`SELECT * FROM thread WHERE session_id = ${sessionId} ORDER BY updated_at DESC`,
		});

		const selectAll = SqlSchema.findAll({
			Request: Schema.Void,
			Result: ThreadRow,
			execute: () => sql`SELECT * FROM thread ORDER BY updated_at DESC`,
		});

		const insertThread = SqlSchema.void({
			Request: ThreadRow.insert,
			execute: (row) => sql`INSERT INTO thread ${sql.insert(row)}`,
		});

		const findEntry = SqlSchema.findOneOption({
			Request: Schema.String,
			Result: EntryRow,
			execute: (id) => sql`SELECT * FROM entry WHERE id = ${id}`,
		});

		// An entry row with `size`, read as `e`.
		const sized = sql`e.*, (SELECT coalesce(sum(length(CAST(p.data AS BLOB))), 0) FROM part p WHERE p.entry_id = e.id) AS size`;

		const findSized = SqlSchema.findOneOption({
			Request: Schema.String,
			Result: SizedEntryRow,
			execute: (id) => sql`SELECT ${sized} FROM entry e WHERE e.id = ${id}`,
		});

		const findCut = SqlSchema.findOneOption({
			Request: Schema.String,
			Result: Schema.Struct({ cut: NonNegativeInt }),
			execute: (threadId) => sql`
				SELECT e.committed_seq AS cut FROM thread t JOIN entry e ON e.id = t.origin_entry_id
				WHERE t.id = ${threadId} AND e.committed_seq IS NOT NULL
			`,
		});

		// The WHERE NOT EXISTS keeps a thread's positions strictly advancing: seq comes from the
		// event that produced the entry, and a stale one would sort the thread out of order.
		// Inserting zero rows is the signal, checked by the callers.
		const insertEntry = SqlSchema.findAll({
			Request: EntryRow.insert,
			Result: Schema.Struct({ id: Schema.String }),
			execute: (row) => sql`
				INSERT INTO entry (id, session_id, thread_id, seq, committed_seq, type, state, data, label, metadata, created_at, updated_at, rev)
				SELECT
					${row.id}, ${row.sessionId}, ${row.threadId}, ${row.seq}, ${row.committedSeq ?? null},
					${row.type}, ${row.state}, ${row.data}, ${row.label ?? null}, ${row.metadata ?? null},
					${row.createdAt}, ${row.updatedAt}, ${row.rev}
				WHERE NOT EXISTS (
					SELECT 1 FROM entry WHERE thread_id = ${row.threadId} AND seq >= ${row.seq}
				)
				RETURNING id
			`,
		});

		// Single-row insert: toolCall and non-tool parts have different encoded
		// key sets (FieldOption omits absent keys), so multi-row sql.insert would
		// mix shapes.
		const insertPart = SqlSchema.void({
			Request: EntryPartRow.insert,
			execute: (row) => sql`INSERT INTO part ${sql.insert(row)}`,
		});

		// The entries of a thread's line that match `where`: its own, then each source's through the
		// cut, up the origin chain. Seq orders them: everything a thread inherits was written before
		// the thread existed, and a thread has one entry per seq.
		const lineOf = (threadId: string, where: ReadonlyArray<Statement.Fragment>) => sql`
			WITH RECURSIVE line(thread_id, upto) AS (
				SELECT id, NULL FROM thread WHERE id = ${threadId}
				UNION ALL
				SELECT t.origin_thread_id, e.committed_seq
				FROM line l
				JOIN thread t ON t.id = l.thread_id
				JOIN entry e ON e.id = t.origin_entry_id
			)
			SELECT ${sized}
			FROM line l
			JOIN entry e ON e.thread_id = l.thread_id AND (l.upto IS NULL OR e.seq <= l.upto)
			WHERE ${sql.and(where)}
		`;

		const selectLine = SqlSchema.findAll({
			Request: Schema.String,
			Result: SizedEntryRow,
			execute: (threadId) => sql`${lineOf(threadId, [])} ORDER BY e.seq`,
		});

		// The budget is a running total over the newest `limit` entries, so it reads no further.
		const selectLinePage = SqlSchema.findAll({
			Request: Schema.Struct({
				threadId: Schema.String,
				before: Schema.optional(Schema.Int),
				budget: Schema.Int,
				limit: Schema.Int,
			}),
			Result: SizedEntryRow,
			execute: ({ threadId, before, budget, limit }) => sql`
				SELECT * FROM (
					SELECT *, sum(size) OVER newest AS total, row_number() OVER newest AS n
					FROM (
						${lineOf(threadId, [
							sql`e.type IN ('user', 'assistant')`,
							...(before === undefined ? [] : [sql`e.seq < ${before}`]),
						])}
						ORDER BY e.seq DESC
						LIMIT ${limit}
					)
					WINDOW newest AS (ORDER BY seq DESC)
				)
				WHERE n = 1 OR total <= ${budget}
				ORDER BY seq DESC
			`,
		});

		const selectDraft = SqlSchema.findOneOption({
			Request: Schema.String,
			Result: SizedEntryRow,
			execute: (threadId) => sql`SELECT ${sized} FROM entry e WHERE e.thread_id = ${threadId} AND e.state = 'draft'`,
		});

		const selectPartsForEntries = SqlSchema.findAll({
			Request: Schema.Array(Schema.String),
			Result: EntryPartRow,
			execute: (entryIds) => sql`
				SELECT * FROM part
				WHERE ${sql.in("entry_id", entryIds)}
				ORDER BY entry_id, part_index
			`,
		});

		const selectUnsettled = SqlSchema.findAll({
			Request: Schema.String,
			Result: EntryPartRow,
			execute: (threadId) => sql`
				SELECT * FROM part
				WHERE thread_id = ${threadId} AND status IN ('pending', 'running')
				ORDER BY entry_id, part_index
			`,
		});

		const epochNow = Effect.map(DateTime.now, DateTime.toEpochMillis);

		// entry.type says whether parts are expected; a mismatch is corruption, not an edge case.
		const hydrate = (entries: ReadonlyArray<SizedEntryRow>, parts: ReadonlyArray<EntryPartRow>): HydratedEntry[] => {
			const byEntry = new Map<string, EntryPartRow[]>();
			for (const part of parts) {
				const bucket = byEntry.get(part.entryId);
				if (bucket) bucket.push(part);
				else byEntry.set(part.entryId, [part]);
			}
			return entries.map(({ size, ...entry }) => ({ entry, parts: byEntry.get(entry.id) ?? [], size }));
		};

		const partsFor = Effect.fnUntraced(function* (entries: ReadonlyArray<SizedEntryRow>) {
			const ids = entries.filter((entry) => messageTypes.has(entry.type)).map((entry) => entry.id);
			if (ids.length === 0) return [];
			return yield* selectPartsForEntries(ids).pipe(Effect.orDie);
		});

		const get = Effect.fn("Thread.get")(function* (threadId: string) {
			return yield* findThread(threadId).pipe(Effect.orDie);
		});

		const main = Effect.fn("Thread.main")(function* (sessionId: string) {
			return yield* findMain(sessionId).pipe(Effect.orDie);
		});

		const list = Effect.fn("Thread.list")(function* (sessionId?: SessionSchema.ID) {
			return yield* (sessionId === undefined ? selectAll() : selectBySession(sessionId)).pipe(Effect.orDie);
		});

		const entry = Effect.fn("Thread.entry")(function* (entryId: string) {
			const found = yield* findSized(entryId).pipe(Effect.orDie);
			if (Option.isNone(found)) return Option.none<HydratedEntry>();
			const parts = yield* partsFor([found.value]);
			return Option.some(hydrate([found.value], parts)[0]!);
		});

		const cut = Effect.fn("Thread.cut")(function* (threadId: string) {
			return Option.map(yield* findCut(threadId).pipe(Effect.orDie), (row) => row.cut);
		});

		const line = Effect.fn("Thread.line")(function* (threadId: ThreadSchema.ID) {
			const entries = yield* selectLine(threadId).pipe(Effect.orDie);
			return hydrate(entries, yield* partsFor(entries));
		});

		const linePage = Effect.fn("Thread.linePage")(function* (input: LinePageInput) {
			const entries = yield* selectLinePage(input).pipe(Effect.orDie);
			return hydrate(entries, yield* partsFor(entries));
		});

		const draft = Effect.fn("Thread.draft")(function* (threadId: ThreadSchema.ID) {
			const found = yield* selectDraft(threadId).pipe(Effect.orDie);
			if (Option.isNone(found)) return Option.none<HydratedEntry>();
			return Option.some(hydrate([found.value], yield* partsFor([found.value]))[0]!);
		});

		const unsettled = Effect.fn("Thread.unsettled")(function* (threadId: ThreadSchema.ID) {
			return yield* selectUnsettled(threadId).pipe(Effect.orDie);
		});

		const insert = Effect.fn("Thread.insert")(
			function* (input: InsertThread) {
				const origin = input.origin;
				const row = yield* ThreadRow.insert.makeEffect({
					id: input.id,
					sessionId: input.sessionId,
					originKind: origin.kind,
					originThreadId: origin.kind === "main" ? Option.none() : Option.some(origin.threadId),
					originEntryId: origin.kind === "main" ? Option.none() : Option.fromUndefinedOr(origin.entryId),
					originCallId: origin.kind === "subagent" ? Option.some(origin.callId) : Option.none(),
					title: Option.fromUndefinedOr(input.title),
					attempt: Option.none(),
					createdSeq: input.seq,
					rev: yield* store.rev,
				});
				yield* insertThread(row);
				// A new thread changes its session.
				yield* sql`UPDATE session SET rev = ${row.rev} WHERE id = ${input.sessionId}`;
			},
			store.write,
			Effect.orDie,
		);

		const writePart = Effect.fnUntraced(function* (
			entryId: string,
			threadId: ThreadSchema.ID,
			partIndex: number,
			part: AppendPart,
		) {
			const partRow = yield* EntryPartRow.insert.makeEffect({
				id: part.id ?? uuidv7(),
				entryId,
				threadId,
				partIndex,
				type: part.type,
				status: Option.fromUndefinedOr(part.status),
				callId: Option.fromUndefinedOr(part.callId),
				toolName: Option.fromUndefinedOr(part.toolName),
				data: part.data,
			});
			yield* insertPart(partRow);
		});

		const writeParts = Effect.fnUntraced(function* (
			entryId: string,
			threadId: ThreadSchema.ID,
			parts: ReadonlyArray<AppendPart>,
		) {
			for (const [partIndex, part] of parts.entries()) yield* writePart(entryId, threadId, partIndex, part);
		});

		// Usage lives on the thread and moves with the envelope stored.
		const addUsage = Effect.fnUntraced(function* (
			thread: ThreadRow,
			delta?: { cost: number; input: number; output: number; cacheRead: number; cacheWrite: number },
		) {
			if (delta === undefined) return;
			yield* sql`
				UPDATE thread SET
					rev = ${yield* store.rev},
					cost = cost + ${delta.cost},
					tokens_input = tokens_input + ${delta.input},
					tokens_output = tokens_output + ${delta.output},
					tokens_cache_read = tokens_cache_read + ${delta.cacheRead},
					tokens_cache_write = tokens_cache_write + ${delta.cacheWrite}
				WHERE id = ${thread.id}
			`;
		});

		type AppendTxResult =
			| { readonly _tag: "threadNotFound" }
			| { readonly _tag: "invalidData"; readonly reason: string }
			| { readonly _tag: "inserted"; readonly entry: EntryRow };

		const append = Effect.fn("Thread.append")(function* (input: AppendEntry) {
			const parts = input.parts ?? [];
			const state = input.state ?? "committed";
			const invalid = (reason: string) => new InvalidEntryDataError({ entryId: input.id, type: input.type, reason });
			if (state === "aborted" || (input.type !== "assistant" && state !== "committed")) {
				return yield* invalid(
					state === "aborted"
						? "an aborted assistant must be produced by abort"
						: `entry type "${input.type}" must be committed`,
				);
			}
			if (parts.length > 0 && !messageTypes.has(input.type)) {
				return yield* invalid(`entry type "${input.type}" must not carry parts`);
			}

			// Part data is documented as verbatim aikit JSON and every reader parses
			// it as such, so it is validated at the write that could reject it.
			for (const [index, part] of parts.entries()) {
				yield* decodeJsonObject(part.data).pipe(
					Effect.mapError((error) =>
						invalid(`part ${index} ("${part.type}") is not a JSON object: ${error.message}`),
					),
				);
			}

			const envelopeIdentity = messageTypes.has(input.type)
				? yield* decodeMessageEnvelopeIdentity(input.data).pipe(Effect.mapError((error) => invalid(error.message)))
				: undefined;
			if (envelopeIdentity !== undefined && envelopeIdentity.messageId !== input.id) {
				return yield* invalid(`messageId "${envelopeIdentity.messageId}" does not match entry id`);
			}

			const compaction =
				input.type === "compaction"
					? yield* decodeCompactionData(input.data).pipe(Effect.mapError((error) => invalid(error.message)))
					: undefined;

			// The envelope is authoritative; aggregate deltas are never accepted
			// independently of the data persisted by this transaction.
			const usage =
				input.type === "assistant"
					? yield* decodeEnvelopeUsage(input.data).pipe(
							Effect.map((envelope) => envelope.usage),
							Effect.mapError((error) => invalid(error.message)),
						)
					: undefined;

			const result: AppendTxResult = yield* store
				.write(
					Effect.gen(function* () {
						const thread = yield* findThread(input.threadId);
						if (Option.isNone(thread)) return { _tag: "threadNotFound" } as const;

						if (compaction !== undefined && compaction.firstKeptEntryId !== null) {
							const entries = yield* selectLine(input.threadId);
							if (!entries.some((one) => one.id === compaction.firstKeptEntryId)) {
								return {
									_tag: "invalidData",
									reason: `firstKeptEntryId "${compaction.firstKeptEntryId}" is not in the thread's line`,
								} as const;
							}
						}

						const entryRow = yield* EntryRow.insert.makeEffect({
							id: input.id,
							sessionId: thread.value.sessionId,
							threadId: input.threadId,
							seq: input.seq,
							committedSeq: state === "committed" ? Option.some(input.seq) : Option.none(),
							type: input.type,
							state,
							data: input.data,
							label: Option.none(),
							metadata: Option.fromUndefinedOr(input.metadata),
							rev: yield* store.rev,
						});
						const inserted = yield* insertEntry(entryRow);
						if (inserted.length === 0) {
							return {
								_tag: "invalidData",
								reason: `seq ${input.seq} does not advance past the thread's latest entry`,
							} as const;
						}
						yield* writeParts(input.id, input.threadId, parts);
						yield* addUsage(
							thread.value,
							usage === undefined
								? undefined
								: {
										cost: usage.cost.total,
										input: usage.input,
										output: usage.output,
										cacheRead: usage.cacheRead,
										cacheWrite: usage.cacheWrite,
									},
						);

						const stored = yield* findEntry(input.id);
						if (Option.isNone(stored)) {
							return yield* Effect.die(new Error("thread append: inserted entry did not persist"));
						}
						return { _tag: "inserted", entry: stored.value } as const;
					}),
				)
				.pipe(Effect.orDie);

			switch (result._tag) {
				case "threadNotFound":
					return yield* new ThreadNotFoundError({ threadId: input.threadId });
				case "invalidData":
					return yield* invalid(result.reason);
				case "inserted":
					return result.entry;
			}
		});

		const usageDelta = Effect.fnUntraced(function* (previous: string, next: string) {
			const before = (yield* decodeEnvelopeUsage(previous)).usage;
			const after = (yield* decodeEnvelopeUsage(next)).usage;
			return {
				cost: after.cost.total - before.cost.total,
				input: after.input - before.input,
				output: after.output - before.output,
				cacheRead: after.cacheRead - before.cacheRead,
				cacheWrite: after.cacheWrite - before.cacheWrite,
			};
		});

		const requireDraft = Effect.fnUntraced(function* (id: string, threadId: ThreadSchema.ID, operation: string) {
			const current = yield* findEntry(id);
			if (
				Option.isNone(current) ||
				current.value.threadId !== threadId ||
				current.value.type !== "assistant" ||
				current.value.state !== "draft"
			) {
				return yield* Effect.die(`${operation} requires draft assistant ${id}`);
			}
			const thread = yield* findThread(threadId);
			if (Option.isNone(thread)) return yield* Effect.die(`${operation}: thread ${threadId} is gone`);
			return { entry: current.value, thread: thread.value };
		});

		const replaceAssistant = Effect.fn("Thread.replaceAssistant")(function* (input: ReplaceAssistant) {
			yield* store.write(
				Effect.gen(function* () {
					const { entry, thread } = yield* requireDraft(input.id, input.threadId, "replaceAssistant");
					const delta = yield* usageDelta(entry.data, input.data);
					const now = yield* epochNow;
					yield* sql`DELETE FROM part WHERE entry_id = ${input.id}`;
					yield* writeParts(input.id, input.threadId, input.parts);
					yield* sql`
						UPDATE entry SET data = ${input.data}, updated_at = ${now}, rev = ${yield* store.rev}
						WHERE id = ${input.id} AND state = 'draft'
					`;
					yield* addUsage(thread, delta);
				}),
			);
		}, Effect.orDie);

		const progress = Effect.fn("Thread.progress")(function* (input: ProgressAssistant) {
			yield* store.write(
				Effect.gen(function* () {
					yield* requireDraft(input.id, input.threadId, "progress");
					const now = yield* epochNow;
					for (const change of input.changes) {
						if (change._tag === "set") {
							yield* sql`DELETE FROM part WHERE entry_id = ${input.id} AND part_index = ${change.partIndex}`;
							yield* writePart(input.id, input.threadId, change.partIndex, change.part);
							continue;
						}
						const [row] = yield* sql<{ readonly data: string }>`
							SELECT data FROM part WHERE entry_id = ${input.id} AND part_index = ${change.partIndex}
						`;
						const data = row === undefined ? undefined : yield* decodeJsonObject(row.data);
						const field =
							data?.["type"] === "text" ? "text" : data?.["type"] === "thinking" ? "thinking" : undefined;
						const text = field === undefined ? undefined : data?.[field];
						if (data === undefined || field === undefined || typeof text !== "string") {
							return yield* Effect.die(`progress cannot append to part ${change.partIndex} of ${input.id}`);
						}
						const next = yield* encodeJsonObject({ ...data, [field]: text + change.text });
						yield* sql`
							UPDATE part SET data = ${next}, updated_at = ${now}
							WHERE entry_id = ${input.id} AND part_index = ${change.partIndex}
						`;
					}
					yield* sql`UPDATE entry SET updated_at = ${now}, rev = ${yield* store.rev} WHERE id = ${input.id}`;
				}),
			);
		}, Effect.orDie);

		const settleToolCall = Effect.fn("Thread.settleToolCall")(
			function* (input: SettleToolCall) {
				const data = yield* decodeJsonObject(input.data).pipe(Effect.orDie);
				if (data["type"] !== "toolCall" || data["callID"] !== input.callId || data["status"] !== input.status) {
					return yield* Effect.die(`settled tool payload does not match call ${input.callId}`);
				}
				const now = yield* epochNow;
				const rows = yield* sql`
				UPDATE part
				SET data = ${input.data}, status = ${input.status}, updated_at = ${now}
				WHERE entry_id = ${input.entryId}
					AND call_id = ${input.callId}
					AND type = 'toolCall'
					AND status IN ('pending', 'running')
					AND EXISTS (SELECT 1 FROM entry WHERE id = ${input.entryId} AND state = 'draft')
				RETURNING id
			`;
				if (rows.length !== 1) {
					return yield* Effect.die(`settleToolCall requires one unsettled call ${input.entryId}/${input.callId}`);
				}
				// The entry's rev covers its parts.
				yield* sql`UPDATE entry SET updated_at = ${now}, rev = ${yield* store.rev} WHERE id = ${input.entryId}`;
			},
			store.write,
			Effect.orDie,
		);

		const commit = Effect.fn("Thread.commit")(
			function* (input: EndAssistant) {
				const now = yield* epochNow;
				const rows = yield* sql`
				UPDATE entry SET state = 'committed', committed_seq = ${input.seq}, updated_at = ${now}, rev = ${yield* store.rev}
				WHERE id = ${input.id}
					AND thread_id = ${input.threadId}
					AND type = 'assistant'
					AND state = 'draft'
					AND NOT EXISTS (
						SELECT 1 FROM part WHERE entry_id = ${input.id} AND status IN ('pending', 'running')
					)
				RETURNING id
			`;
				if (rows.length !== 1) return yield* Effect.die(`commit requires a fully-settled draft ${input.id}`);
			},
			store.write,
			Effect.orDie,
		);

		const abort = Effect.fn("Thread.abort")(function* (input: ReplaceAssistant & EndAssistant) {
			yield* store.write(
				Effect.gen(function* () {
					const { entry, thread } = yield* requireDraft(input.id, input.threadId, "abort");
					const delta = yield* usageDelta(entry.data, input.data);
					const now = yield* epochNow;
					yield* sql`DELETE FROM part WHERE entry_id = ${input.id}`;
					yield* writeParts(input.id, input.threadId, input.parts);
					yield* sql`
						UPDATE entry
						SET state = 'aborted', committed_seq = ${input.seq}, data = ${input.data}, updated_at = ${now},
							rev = ${yield* store.rev}
						WHERE id = ${input.id} AND state = 'draft'
					`;
					yield* addUsage(thread, delta);
				}),
			);
		}, Effect.orDie);

		/**
		 * Resolves a fork request to the stored origin: the committed entry it is cut at, owned by the
		 * thread that wrote it, which is not always the thread asked for.
		 */
		const forkPoint = Effect.fnUntraced(function* (input: ForkInput) {
			const reject = (reason: ForkError["reason"]) =>
				Effect.fail(new ForkError({ threadId: input.threadId, entryId: input.entryId, reason }));
			const entries = yield* selectLine(input.threadId).pipe(Effect.orDie);
			const index = entries.findIndex((one) => one.id === input.entryId);
			const target = entries[index];
			if (target === undefined) return yield* reject("entry_not_found");
			if (target.state !== "committed") return yield* reject("entry_not_committed");
			if (input.mode !== "before") return { point: target, text: undefined };
			if (target.type !== "user") return yield* reject("not_a_user_entry");
			const before = entries.slice(0, index).findLast((one) => one.state === "committed");
			if (before === undefined) return yield* reject("nothing_before_entry");
			const parts = yield* partsFor([target]);
			const text = parts
				.flatMap((part) => Option.toArray(decodeUserText(part.data)))
				.map((part) => part.text)
				.join("\n\n");
			return { point: before, text };
		});

		const fork = Effect.fn("Thread.fork")(function* (input: ForkInput) {
			const source = yield* findThread(input.threadId).pipe(Effect.orDie);
			if (Option.isNone(source)) return yield* new ThreadNotFoundError({ threadId: input.threadId });
			const { point, text } = yield* forkPoint(input);
			const id = input.id ?? ThreadSchema.ID.create();
			yield* events.publish(EventList.ThreadForked, {
				timestamp: yield* DateTime.now,
				sessionId: SessionSchema.ID.make(source.value.sessionId),
				threadId: id,
				sourceThreadId: input.threadId,
				originThreadId: ThreadSchema.ID.make(point.threadId),
				entryId: point.id,
			});
			const created = yield* findThread(id).pipe(Effect.orDie);
			if (Option.isNone(created)) return yield* Effect.die(new Error("thread fork did not persist"));
			return { thread: created.value, ...(text === undefined ? {} : { text }) } satisfies Forked;
		});

		const projectForked = Effect.fn("Thread.projectForked")(
			function* (input: EventList.ThreadForked["data"], seq: number) {
				// Checked again inside the commit: the session may have been deleted since the request was read.
				const point = yield* findEntry(input.entryId).pipe(Effect.orDie);
				if (
					Option.isNone(point) ||
					point.value.threadId !== input.originThreadId ||
					point.value.state !== "committed" ||
					Option.isNone(point.value.committedSeq)
				) {
					return yield* Effect.die(
						`fork point ${input.entryId} is not a committed entry of ${input.originThreadId}`,
					);
				}
				const cut = point.value.committedSeq.value;
				yield* insert({
					id: input.threadId,
					sessionId: input.sessionId,
					origin: { kind: "fork", threadId: input.originThreadId, entryId: input.entryId },
					seq,
				});
				// The documents in effect at the cut are the owner's: every thread between the source and
				// the owner was created after it.
				for (const document of yield* documents.ofThread(input.sourceThreadId)) {
					const policy = Option.getOrUndefined(document.fork);
					if (policy === undefined || policy === "initial") continue;
					const owned =
						policy === "asOf"
							? yield* documents.find(input.originThreadId, document.kind)
							: Option.some(document);
					if (Option.isNone(owned)) continue;
					const value =
						policy === "asOf"
							? yield* documents.asOf(owned.value.id, cut)
							: yield* documents.current(owned.value.id);
					if (Option.isNone(value)) continue;
					yield* documents.create({
						sessionId: input.sessionId,
						threadId: input.threadId,
						definition: {
							kind: document.kind,
							version: value.value.version,
							scope: "thread",
							...Option.match(document.history, { onNone: () => ({}), onSome: (history) => ({ history }) }),
							fork: policy,
						},
						value: value.value.value,
						seq,
					});
				}
				// Every thread has an agent document, whatever its source held.
				if (Option.isNone(yield* documents.find(input.threadId, DocumentSchema.agent.kind))) {
					yield* documents.create({
						sessionId: input.sessionId,
						threadId: input.threadId,
						definition: DocumentSchema.agent,
						value: {},
						seq,
					});
				}
			},
			store.write,
			Effect.orDie,
		);

		const retitle = Effect.fn("Thread.retitle")(
			function* (threadId: ThreadSchema.ID, title: string) {
				const changed = yield* sql<{ readonly id: string }>`
				UPDATE thread SET title = ${title}, rev = ${yield* store.rev} WHERE id = ${threadId} AND title IS NULL RETURNING id
			`;
				return changed.length > 0;
			},
			store.write,
			Effect.orDie,
		);

		/** Over a `thread` row: a pending prompt past its head, woken since the last unanswered end. */
		const runnableOf = sql`EXISTS (
			SELECT 1 FROM inbox
			WHERE inbox.thread_id = thread.id AND inbox.promoted_seq IS NULL AND inbox.cancelled_seq IS NULL
				AND inbox.tail > thread.head
		)`;
		/** Over a `thread` row: its last run was cut off by the host, not ended. */
		const interruptedOf = (reasons: ReadonlyArray<SessionSchema.InterruptReason>) =>
			sql`(thread.run_outcome = 'interrupted' AND json_extract(thread.run_error, '$.reason') IN ${sql.in(reasons)})`;
		const unfinishedOf = sql`(${interruptedOf(["crash", "shutdown"])} OR ${runnableOf})`;
		/*
		 * Over a `thread` row: its run sleeps in retry backoff, its attempt set and no draft open (the failed
		 * attempt's draft was aborted before the sleep). A crash there is no restart: a receive count, as SQS
		 * keeps one per message, counts only deliveries being worked on, and a sleeping one is not; its
		 * carried attempt bounds it instead. The moment between setting the attempt and opening its draft
		 * reads as asleep too, bounded the same way.
		 */
		const asleepOf = sql`(thread.attempt IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM entry WHERE entry.thread_id = thread.id AND entry.state = 'draft'
		))`;

		const claimRestart = Effect.fn("Thread.claimRestart")(
			function* (threadId: ThreadSchema.ID) {
				const rows = yield* sql<{ restarts: number }>`
				UPDATE thread
				SET restarts = restarts + (CASE WHEN ${interruptedOf(["crash"])} AND NOT ${asleepOf} THEN 1 ELSE 0 END),
					rev = ${yield* store.rev}
				WHERE id = ${threadId} AND ${unfinishedOf}
				RETURNING restarts
			`;
				return Option.fromUndefinedOr(rows[0]?.restarts);
			},
			store.write,
			Effect.orDie,
		);

		const resetRestarts = Effect.fn("Thread.resetRestarts")(
			function* (threadId: ThreadSchema.ID) {
				yield* sql`UPDATE thread SET restarts = 0, rev = ${yield* store.rev} WHERE id = ${threadId} AND restarts > 0`;
			},
			store.write,
			Effect.orDie,
		);

		const setAttempt = Effect.fn("Thread.setAttempt")(
			function* (threadId: ThreadSchema.ID, attempt: number | null) {
				yield* sql`UPDATE thread SET attempt = ${attempt}, rev = ${yield* store.rev} WHERE id = ${threadId}`;
			},
			store.write,
			Effect.orDie,
		);

		const holds = (name: string, predicate: Statement.Fragment) =>
			Effect.fn(name)(function* (threadId: ThreadSchema.ID) {
				const rows = yield* sql<{ holds: number }>`SELECT ${predicate} AS holds FROM thread WHERE id = ${threadId}`;
				return rows[0]?.holds === 1;
			}, Effect.orDie);
		const runnable = holds("Thread.runnable", runnableOf);
		const resumable = holds("Thread.resumable", unfinishedOf);
		const cutOff = holds("Thread.cutOff", interruptedOf(["crash", "shutdown"]));

		const findUnfinished = SqlSchema.findAll({
			Request: Schema.Void,
			Result: ThreadRow,
			execute: () => sql`
				SELECT * FROM thread WHERE ${unfinishedOf} ORDER BY updated_at
			`,
		});
		const unfinished = findUnfinished(undefined).pipe(Effect.orDie, Effect.withSpan("Thread.unfinished"));

		const projectRun = Effect.fn("Thread.projectRun")(function* (
			threadId: ThreadSchema.ID,
			at: DateTime.Utc,
			change: RunChange,
		) {
			const time = DateTime.toEpochMillis(at);
			const rev = yield* store.rev;
			const state: ThreadSchema.RunState =
				change._tag === "started" ? "starting" : change._tag === "running" ? "running" : "idle";
			// SET reads the old row, so `run_state_at` moves only when the state does.
			const stateAt = sql`CASE WHEN run_state = ${state} THEN run_state_at ELSE ${time} END`;
			// Checked inside the event's commit: a lifecycle event for a thread deleted since its publisher read it
			// must roll back, or it recreates the session's sequence row.
			const found = (rows: ReadonlyArray<unknown>) =>
				rows.length > 0 ? Effect.void : Effect.die(new ThreadNotFoundError({ threadId }));
			if (change._tag === "running") {
				return yield* found(
					yield* sql`UPDATE thread SET run_state_at = ${stateAt}, run_state = ${state}, rev = ${rev} WHERE id = ${threadId} RETURNING id`,
				);
			}
			if (change._tag === "started") {
				return yield* found(
					yield* sql`
					UPDATE thread SET
						run_state_at = ${stateAt}, run_state = ${state}, run_started_at = ${time},
						run_ended_at = NULL, run_outcome = NULL, run_error = NULL, rev = ${rev}
					WHERE id = ${threadId}
					RETURNING id
				`,
				);
			}
			const error = change.error === undefined ? null : yield* encodeRunError(change.error);
			const interrupted = change.error?._tag === "interrupted" ? change.error.reason : undefined;
			// An unanswered end parks what is queued: a prompt woken before it waits for the next one.
			const head = change.outcome === "failed" || interrupted === "user" ? sql`MAX(head, ${change.seq})` : sql`head`;
			// A run already ended keeps the outcome of the terminal that ended it; a later one only parks. One the
			// host cut off is still owed its end: a stop before its resume is that end.
			const parked = yield* sql`
				UPDATE thread SET head = ${head}, rev = ${rev}
				WHERE id = ${threadId} AND run_state = 'idle' AND NOT ${interruptedOf(["crash", "shutdown"])}
				RETURNING id
			`;
			if (parked.length > 0) return;
			// A run the host cut off resumes, a clean shutdown's too: it keeps its count for the resume to claim and
			// its attempt, so a restart does not hand a failing request a fresh retry budget.
			const cutOff = interrupted === "crash" || interrupted === "shutdown";
			const restarts = cutOff ? sql`restarts` : sql`0`;
			const attempt = cutOff ? sql`attempt` : sql`NULL`;
			yield* found(
				yield* sql`
				UPDATE thread SET
					run_state_at = ${stateAt}, run_state = ${state}, run_ended_at = ${time},
					run_outcome = ${change.outcome}, run_error = ${error}, head = ${head}, restarts = ${restarts},
					attempt = ${attempt}, rev = ${rev}
				WHERE id = ${threadId}
				RETURNING id
			`,
			);
		}, Effect.orDie);

		const findOpen = SqlSchema.findAll({
			Request: Schema.Void,
			Result: ThreadRow,
			execute: () => sql`SELECT * FROM thread WHERE run_state <> 'idle' ORDER BY updated_at`,
		});
		const open = findOpen(undefined).pipe(Effect.orDie, Effect.withSpan("Thread.open"));

		const setLabel = Effect.fn("Thread.setLabel")(function* (input: {
			threadId: ThreadSchema.ID;
			entryId: string;
			label: string | null;
		}) {
			const rows = yield* Effect.gen(function* () {
				const now = yield* epochNow;
				return yield* sql`
					UPDATE entry SET label = ${input.label}, updated_at = ${now}, rev = ${yield* store.rev}
					WHERE id = ${input.entryId} AND thread_id = ${input.threadId}
					RETURNING id
				`;
			}).pipe(store.write, Effect.orDie);
			if (rows.length === 0) {
				return yield* new EntryNotFoundError({ threadId: input.threadId, entryId: input.entryId });
			}
		});

		return Service.of({
			get,
			main,
			list,
			entry,
			cut,
			line,
			linePage,
			draft,
			unsettled,
			insert,
			append,
			replaceAssistant,
			progress,
			settleToolCall,
			commit,
			abort,
			fork,
			projectForked,
			retitle,
			claimRestart,
			resetRestarts,
			setAttempt,
			runnable,
			resumable,
			cutOff,
			unfinished,
			projectRun,
			open,
			setLabel,
		});
	}),
);

export * as Thread from "./thread.ts";
