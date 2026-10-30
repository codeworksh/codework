import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
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

/** Ends a draft assistant: committed once every tool part is settled, or aborted (parts dropped). */
export interface EndAssistant {
	readonly id: string;
	readonly threadId: ThreadSchema.ID;
	/** The event that ends it; becomes its `committedSeq`. */
	readonly seq: number;
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

/** What a projector inserts for a new thread; usage and execution start empty. */
export interface InsertThread {
	readonly id: ThreadSchema.ID;
	readonly sessionId: SessionSchema.ID;
	readonly origin: ThreadSchema.Origin;
	readonly title?: string;
	readonly seq: number;
}

// Entry row + its part rows, zipped. Message decode happens above this layer.
export interface HydratedEntry {
	readonly entry: EntryRow;
	readonly parts: ReadonlyArray<EntryPartRow>;
}

export interface Interface {
	readonly get: (threadId: string) => Effect.Effect<Option.Option<ThreadRow>>;
	/** The session's main thread; none when the session is unknown. */
	readonly main: (sessionId: string) => Effect.Effect<Option.Option<ThreadRow>>;
	/** Threads newest first: of one session, or of the whole database. */
	readonly list: (sessionId?: SessionSchema.ID) => Effect.Effect<ReadonlyArray<ThreadRow>>;
	readonly entry: (entryId: string) => Effect.Effect<Option.Option<HydratedEntry>>;
	/**
	 * The thread's line: its own entries, then its source's through the fork entry, recursively, in
	 * seq order. Every state is included; context assembly drops what is not committed.
	 */
	readonly line: (threadId: ThreadSchema.ID) => Effect.Effect<ReadonlyArray<HydratedEntry>>;
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
	/** Projector-only: settle one pending/running tool part on a draft assistant. */
	readonly settleToolCall: (input: SettleToolCall) => Effect.Effect<void>;
	/** Projector-only: commit a draft after every tool part is terminal. */
	readonly commit: (input: EndAssistant) => Effect.Effect<void>;
	/** Projector-only: turn a draft into a partless aborted tombstone. */
	readonly abort: (input: EndAssistant & { readonly data: string }) => Effect.Effect<void>;
	/** Cut a new thread off `threadId`'s line at a committed entry. */
	readonly fork: (input: ForkInput) => Effect.Effect<Forked, ThreadNotFoundError | ForkError>;
	/** Projector of `session.thread.forked`: the thread and its copied documents, at the event's seq. */
	readonly projectForked: (input: EventList.ThreadForked["data"], seq: number) => Effect.Effect<void>;
	/** Names an untitled thread. Returns whether the title changed. */
	readonly retitle: (threadId: ThreadSchema.ID, title: string) => Effect.Effect<boolean>;
	/** Records that the thread has a run to do: one starting, or one a prompt just woke. */
	readonly markRunning: (threadId: ThreadSchema.ID) => Effect.Effect<void>;
	/**
	 * Records how a run ended. `closed` (a shutdown) leaves it to resume. `stopped` (the user) and
	 * `finished` clear it and the restart count, except that a finished run with prompts still
	 * pending stays marked: they are accepted work a successor, or the next server start, runs.
	 */
	readonly endExecution: (
		threadId: ThreadSchema.ID,
		end: "finished" | "stopped" | "closed",
		/** For a stop: the log position it was asked at. A prompt admitted after it keeps the mark. */
		stoppedAt?: number,
	) => Effect.Effect<void>;
	/**
	 * Claims a thread's unfinished run for recovery: marks it running again, counting a restart when
	 * a dying process left it running (a shutdown's closed run is not counted). The new count, or none
	 * when nothing is unfinished any more, say because the user stopped it since.
	 */
	readonly claimRestart: (threadId: ThreadSchema.ID) => Effect.Effect<Option.Option<number>>;
	/** A committed turn is progress: the restart count starts over. Runs inside `TurnEnded`'s commit. */
	readonly resetRestarts: (threadId: ThreadSchema.ID) => Effect.Effect<void>;
	/** Root threads with a run left unfinished, oldest first. */
	readonly unfinished: Effect.Effect<ReadonlyArray<ThreadRow>>;
	/** Set or clear (null) the bookmark label on an entry of the thread. */
	readonly setLabel: (input: {
		threadId: ThreadSchema.ID;
		entryId: string;
		label: string | null;
	}) => Effect.Effect<void, EntryNotFoundError>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/thread/thread/Service") {}

const messageTypes: ReadonlySet<string> = new Set(messageEntryTypes);

// Structural decode of the persisted envelope's usage; failures surface as
// InvalidEntryDataError, never a defect — callers (Context Manager, UI) can act.
const decodeEnvelopeUsage = Schema.decodeUnknownEffect(SessionSchema.AssistantEnvelopeUsage);
const decodeMessageEnvelopeIdentity = Schema.decodeUnknownEffect(SessionSchema.MessageEnvelopeIdentity);
const decodeCompactionData = Schema.decodeUnknownEffect(SessionSchema.CompactionData);
const decodeJsonObject = Schema.decodeUnknownEffect(SessionSchema.JsonObject);
const decodeUserText = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
);

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
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

		// The WHERE NOT EXISTS keeps a thread's positions strictly advancing: seq comes from the
		// event that produced the entry, and a stale one would sort the thread out of order.
		// Inserting zero rows is the signal, checked by the callers.
		const insertEntry = SqlSchema.findAll({
			Request: EntryRow.insert,
			Result: Schema.Struct({ id: Schema.String }),
			execute: (row) => sql`
				INSERT INTO entry (id, session_id, thread_id, seq, committed_seq, type, state, data, label, metadata, created_at, updated_at)
				SELECT
					${row.id}, ${row.sessionId}, ${row.threadId}, ${row.seq}, ${row.committedSeq ?? null},
					${row.type}, ${row.state}, ${row.data}, ${row.label ?? null}, ${row.metadata ?? null},
					${row.createdAt}, ${row.updatedAt}
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

		// Seq order is enough: everything a thread inherits was written before the thread existed,
		// and a thread has one entry per seq.
		const selectLine = SqlSchema.findAll({
			Request: Schema.String,
			Result: EntryRow,
			execute: (threadId) => sql`
				WITH RECURSIVE line(thread_id, upto) AS (
					SELECT id, NULL FROM thread WHERE id = ${threadId}
					UNION ALL
					SELECT t.origin_thread_id, e.committed_seq
					FROM line l
					JOIN thread t ON t.id = l.thread_id
					JOIN entry e ON e.id = t.origin_entry_id
				)
				SELECT e.*
				FROM line l
				JOIN entry e ON e.thread_id = l.thread_id AND (l.upto IS NULL OR e.seq <= l.upto)
				ORDER BY e.seq
			`,
		});

		const selectDraft = SqlSchema.findOneOption({
			Request: Schema.String,
			Result: EntryRow,
			execute: (threadId) => sql`SELECT * FROM entry WHERE thread_id = ${threadId} AND state = 'draft'`,
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
		const hydrate = (entries: ReadonlyArray<EntryRow>, parts: ReadonlyArray<EntryPartRow>): HydratedEntry[] => {
			const byEntry = new Map<string, EntryPartRow[]>();
			for (const part of parts) {
				const bucket = byEntry.get(part.entryId);
				if (bucket) bucket.push(part);
				else byEntry.set(part.entryId, [part]);
			}
			return entries.map((entry) => ({ entry, parts: byEntry.get(entry.id) ?? [] }));
		};

		const partsFor = Effect.fnUntraced(function* (entries: ReadonlyArray<EntryRow>) {
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
			const found = yield* findEntry(entryId).pipe(Effect.orDie);
			if (Option.isNone(found)) return Option.none<HydratedEntry>();
			const parts = yield* partsFor([found.value]);
			return Option.some(hydrate([found.value], parts)[0]!);
		});

		const line = Effect.fn("Thread.line")(function* (threadId: ThreadSchema.ID) {
			const entries = yield* selectLine(threadId).pipe(Effect.orDie);
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

		const insert = Effect.fn("Thread.insert")(function* (input: InsertThread) {
			const origin = input.origin;
			const row = yield* ThreadRow.insert.makeEffect({
				id: input.id,
				sessionId: input.sessionId,
				originKind: origin.kind,
				originThreadId: origin.kind === "main" ? Option.none() : Option.some(origin.threadId),
				originEntryId: origin.kind === "main" ? Option.none() : Option.fromUndefinedOr(origin.entryId),
				originCallId: origin.kind === "subagent" ? Option.some(origin.callId) : Option.none(),
				title: Option.fromUndefinedOr(input.title),
				execution: Option.none(),
				createdSeq: input.seq,
			});
			yield* insertThread(row);
		}, Effect.orDie);

		const writeParts = Effect.fnUntraced(function* (
			entryId: string,
			threadId: ThreadSchema.ID,
			parts: ReadonlyArray<AppendPart>,
		) {
			for (const [partIndex, part] of parts.entries()) {
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
			}
		});

		// Usage lives on the thread and moves with the envelope stored; the session's last activity
		// moves with it.
		const touch = Effect.fnUntraced(function* (
			thread: ThreadRow,
			delta?: { cost: number; input: number; output: number; cacheRead: number; cacheWrite: number },
		) {
			const now = yield* epochNow;
			yield* sql`
				UPDATE thread SET
					updated_at = ${now},
					cost = cost + ${delta?.cost ?? 0},
					tokens_input = tokens_input + ${delta?.input ?? 0},
					tokens_output = tokens_output + ${delta?.output ?? 0},
					tokens_cache_read = tokens_cache_read + ${delta?.cacheRead ?? 0},
					tokens_cache_write = tokens_cache_write + ${delta?.cacheWrite ?? 0}
				WHERE id = ${thread.id}
			`;
			yield* sql`UPDATE session SET updated_at = ${now} WHERE id = ${thread.sessionId}`;
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

			const result: AppendTxResult = yield* sql
				.withTransaction(
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
						});
						const inserted = yield* insertEntry(entryRow);
						if (inserted.length === 0) {
							return {
								_tag: "invalidData",
								reason: `seq ${input.seq} does not advance past the thread's latest entry`,
							} as const;
						}
						yield* writeParts(input.id, input.threadId, parts);
						yield* touch(
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
			yield* sql.withTransaction(
				Effect.gen(function* () {
					const { entry, thread } = yield* requireDraft(input.id, input.threadId, "replaceAssistant");
					const delta = yield* usageDelta(entry.data, input.data);
					const now = yield* epochNow;
					yield* sql`DELETE FROM part WHERE entry_id = ${input.id}`;
					yield* writeParts(input.id, input.threadId, input.parts);
					yield* sql`
						UPDATE entry SET data = ${input.data}, updated_at = ${now}
						WHERE id = ${input.id} AND state = 'draft'
					`;
					yield* touch(thread, delta);
				}),
			);
		}, Effect.orDie);

		const settleToolCall = Effect.fn("Thread.settleToolCall")(function* (input: SettleToolCall) {
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
		}, Effect.orDie);

		const commit = Effect.fn("Thread.commit")(function* (input: EndAssistant) {
			const now = yield* epochNow;
			const rows = yield* sql`
				UPDATE entry SET state = 'committed', committed_seq = ${input.seq}, updated_at = ${now}
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
			yield* sql`UPDATE thread SET updated_at = ${now} WHERE id = ${input.threadId}`;
		}, Effect.orDie);

		const abort = Effect.fn("Thread.abort")(function* (input: EndAssistant & { readonly data: string }) {
			yield* sql.withTransaction(
				Effect.gen(function* () {
					const { entry, thread } = yield* requireDraft(input.id, input.threadId, "abort");
					const delta = yield* usageDelta(entry.data, input.data);
					const now = yield* epochNow;
					yield* sql`DELETE FROM part WHERE entry_id = ${input.id}`;
					yield* sql`
						UPDATE entry
						SET state = 'aborted', committed_seq = ${input.seq}, data = ${input.data}, updated_at = ${now}
						WHERE id = ${input.id} AND state = 'draft'
					`;
					yield* touch(thread, delta);
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

		const projectForked = Effect.fn("Thread.projectForked")(function* (
			input: EventList.ThreadForked["data"],
			seq: number,
		) {
			// Checked again inside the commit: the session may have been deleted since the request was read.
			const point = yield* findEntry(input.entryId).pipe(Effect.orDie);
			if (
				Option.isNone(point) ||
				point.value.threadId !== input.originThreadId ||
				point.value.state !== "committed" ||
				Option.isNone(point.value.committedSeq)
			) {
				return yield* Effect.die(`fork point ${input.entryId} is not a committed entry of ${input.originThreadId}`);
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
					policy === "asOf" ? yield* documents.find(input.originThreadId, document.kind) : Option.some(document);
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
		});

		const retitle = Effect.fn("Thread.retitle")(function* (threadId: ThreadSchema.ID, title: string) {
			const changed = yield* sql<{ readonly id: string }>`
				UPDATE thread SET title = ${title} WHERE id = ${threadId} AND title IS NULL RETURNING id
			`.pipe(Effect.orDie);
			return changed.length > 0;
		});

		const markRunning = Effect.fn("Thread.markRunning")(function* (threadId: ThreadSchema.ID) {
			yield* sql`UPDATE thread SET execution = 'running' WHERE id = ${threadId}`;
		}, Effect.orDie);

		const endExecution = Effect.fn("Thread.endExecution")(function* (
			threadId: ThreadSchema.ID,
			end: "finished" | "stopped" | "closed",
			stoppedAt?: number,
		) {
			if (end === "closed") {
				yield* sql`UPDATE thread SET execution = 'closed' WHERE id = ${threadId}`;
				return;
			}
			// Pending prompts that keep the mark: any for a finished run; for a stop, only those sent
			// after it, since what was queued before it stays parked by the user's choice.
			const after = end === "stopped" ? (stoppedAt ?? Number.MAX_SAFE_INTEGER) : -1;
			yield* sql`
				UPDATE thread SET execution = NULL, restarts = 0
				WHERE id = ${threadId} AND NOT EXISTS (
					SELECT 1 FROM inbox
					WHERE thread_id = ${threadId} AND promoted_seq IS NULL AND cancelled_seq IS NULL
						AND admitted_seq > ${after}
				)
			`;
		}, Effect.orDie);

		const claimRestart = Effect.fn("Thread.claimRestart")(function* (threadId: ThreadSchema.ID) {
			const rows = yield* sql<{ restarts: number }>`
				UPDATE thread
				SET restarts = restarts + (CASE WHEN execution = 'running' THEN 1 ELSE 0 END), execution = 'running'
				WHERE id = ${threadId} AND execution IS NOT NULL
				RETURNING restarts
			`;
			return Option.fromUndefinedOr(rows[0]?.restarts);
		}, Effect.orDie);

		const resetRestarts = Effect.fn("Thread.resetRestarts")(function* (threadId: ThreadSchema.ID) {
			yield* sql`UPDATE thread SET restarts = 0 WHERE id = ${threadId} AND restarts > 0`;
		}, Effect.orDie);

		const findUnfinished = SqlSchema.findAll({
			Request: Schema.Void,
			Result: ThreadRow,
			execute: () => sql`
				SELECT * FROM thread WHERE execution IS NOT NULL AND origin_kind <> 'subagent' ORDER BY updated_at
			`,
		});
		const unfinished = findUnfinished(undefined).pipe(Effect.orDie, Effect.withSpan("Thread.unfinished"));

		const setLabel = Effect.fn("Thread.setLabel")(function* (input: {
			threadId: ThreadSchema.ID;
			entryId: string;
			label: string | null;
		}) {
			const now = yield* epochNow;
			const rows = yield* sql`
				UPDATE entry SET label = ${input.label}, updated_at = ${now}
				WHERE id = ${input.entryId} AND thread_id = ${input.threadId}
				RETURNING id
			`.pipe(Effect.orDie);
			if (rows.length === 0) {
				return yield* new EntryNotFoundError({ threadId: input.threadId, entryId: input.entryId });
			}
		});

		return Service.of({
			get,
			main,
			list,
			entry,
			line,
			draft,
			unsettled,
			insert,
			append,
			replaceAssistant,
			settleToolCall,
			commit,
			abort,
			fork,
			projectForked,
			retitle,
			markRunning,
			endExecution,
			claimRestart,
			resetRestarts,
			unfinished,
			setLabel,
		});
	}),
);

export * as Thread from "./thread.ts";
