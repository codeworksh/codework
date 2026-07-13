import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { uuidv7 } from "uuidv7";
import { Database } from "../db/db";
import {
	type EntryType,
	entryTypes,
	type MessageEntryType,
	messageEntryTypes,
	type PartType,
	partTypes,
	SessionEntryPartRow,
	SessionEntryRow,
	SessionRow,
	type ToolStatus,
	toolStatuses,
} from "../db/schema.sql";
import type { AbsolutePath } from "../schema";
import { AssistantEnvelopeUsage } from "./schema";

export {
	entryTypes,
	messageEntryTypes,
	partTypes,
	SessionEntryPartRow,
	SessionEntryRow,
	SessionRow,
	toolStatuses,
	type EntryType,
	type MessageEntryType,
	type PartType,
	type ToolStatus,
};

export class SessionNotFoundError extends Schema.TaggedErrorClass<SessionNotFoundError>()("SessionNotFoundError", {
	sessionId: Schema.String,
}) {}

export class EntryNotFoundError extends Schema.TaggedErrorClass<EntryNotFoundError>()("EntryNotFoundError", {
	sessionId: Schema.String,
	entryId: Schema.String,
}) {}

export class ToolCallNotFoundError extends Schema.TaggedErrorClass<ToolCallNotFoundError>()("ToolCallNotFoundError", {
	entryId: Schema.String,
	callId: Schema.String,
}) {}

export class LeafConflictError extends Schema.TaggedErrorClass<LeafConflictError>()("LeafConflictError", {
	sessionId: Schema.String,
	expectedLeafEntryId: Schema.NullOr(Schema.String),
	actualLeafEntryId: Schema.NullOr(Schema.String),
}) {}

// Structural rejection — the data-structure layer's "index out of bounds".
export class InvalidEntryDataError extends Schema.TaggedErrorClass<InvalidEntryDataError>()("InvalidEntryDataError", {
	entryId: Schema.String,
	type: Schema.String,
	reason: Schema.String,
}) {}

export interface CreateSession {
	readonly id?: string;
	readonly projectId: string;
	readonly parentId?: string; // session hierarchy (subagents) or fork lineage
	readonly slug: string;
	readonly directory: AbsolutePath;
	readonly title: string;
	readonly tag: string;
	readonly metadata?: Readonly<Record<string, string>>;
}

// Billed usage inside a persisted assistant envelope (harness-owned, ./schema).
export { AssistantEnvelopeUsage, Usage } from "./schema";

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
	readonly sessionId: string;
	readonly type: EntryType;
	readonly data: string; // JSON: full payload, or message envelope
	readonly parts?: ReadonlyArray<AppendPart>; // order = partIndex; message types only
	readonly parentId?: string; // explicit branch appends only; default = current leaf
	/** Guard the first append of a run against a leaf changed after context assembly. */
	readonly expectedLeafEntryId?: string | null;
}

export interface SettleToolCall {
	readonly entryId: string; // owning assistant entry
	readonly callId: string; // from the loop's tool.execution.end
	readonly status: Exclude<ToolStatus, "pending" | "running">;
	readonly data: string; // settled aikit part JSON, verbatim
}

// Entry row + its part rows, zipped. Message decode happens above this layer.
export interface HydratedEntry {
	readonly entry: SessionEntryRow;
	readonly parts: ReadonlyArray<SessionEntryPartRow>;
}

export interface Interface {
	readonly create: (input: CreateSession) => Effect.Effect<SessionRow>;
	readonly get: (sessionId: string) => Effect.Effect<Option.Option<SessionRow>>;
	readonly list: (input: { projectId: string }) => Effect.Effect<SessionRow[]>;
	readonly entry: (entryId: string) => Effect.Effect<Option.Option<HydratedEntry>>;
	/** Active root→leaf path with parts attached. */
	readonly path: (sessionId: string) => Effect.Effect<HydratedEntry[]>;
	/** All branches, newest-first, paged by entry seq. */
	readonly timeline: (input: {
		sessionId: string;
		cursorSeq?: number;
		limit?: number;
	}) => Effect.Effect<HydratedEntry[]>;
	/** Unsettled toolCall parts (crash recovery / live status). */
	readonly unsettled: (sessionId: string) => Effect.Effect<SessionEntryPartRow[]>;
	readonly append: (
		input: AppendEntry,
	) => Effect.Effect<
		SessionEntryRow,
		SessionNotFoundError | EntryNotFoundError | LeafConflictError | InvalidEntryDataError
	>;
	readonly settleToolCall: (input: SettleToolCall) => Effect.Effect<void, ToolCallNotFoundError>;
	/** Move the leaf cursor; the next append forks a sibling branch. */
	readonly branch: (input: { sessionId: string; entryId: string }) => Effect.Effect<void, EntryNotFoundError>;
	/** Set or clear (null) the bookmark label on an entry. */
	readonly setLabel: (input: {
		sessionId: string;
		entryId: string;
		label: string | null;
	}) => Effect.Effect<void, EntryNotFoundError>;
}

export class Service extends Context.Service<Service, Interface>()("@codework/session") {}

const messageTypes: ReadonlySet<string> = new Set(messageEntryTypes);

// Structural decode of the persisted envelope's usage; failures surface as
// InvalidEntryDataError, never a defect — callers (Context Manager, UI) can act.
const decodeEnvelopeUsage = Schema.decodeUnknownEffect(AssistantEnvelopeUsage);

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;

		const findSession = SqlSchema.findOneOption({
			Request: Schema.String,
			Result: SessionRow,
			execute: (id) => sql`SELECT * FROM session WHERE id = ${id}`,
		});

		const selectSessions = SqlSchema.findAll({
			Request: Schema.String,
			Result: SessionRow,
			execute: (projectId) => sql`SELECT * FROM session WHERE project_id = ${projectId} ORDER BY updated_at DESC`,
		});

		const insertSession = SqlSchema.void({
			Request: SessionRow.insert,
			execute: (row) => sql`INSERT INTO session ${sql.insert(row)}`,
		});

		const findEntry = SqlSchema.findOneOption({
			Request: Schema.String,
			Result: SessionEntryRow,
			execute: (id) => sql`SELECT * FROM session_entry WHERE id = ${id}`,
		});

		// seq is computed inside the INSERT — no read-modify-write window. SQLite
		// serializes write transactions, so two appends cannot commit the same
		// max(seq) + 1; the unique (session_id, seq) index is the backstop.
		const insertEntry = SqlSchema.void({
			Request: SessionEntryRow.insert,
			execute: (row) => sql`
				INSERT INTO session_entry (id, session_id, parent_id, seq, type, data, label, metadata, created_at, updated_at)
				VALUES (
					${row.id}, ${row.sessionId}, ${row.parentId ?? null},
					(SELECT COALESCE(MAX(seq), 0) + 1 FROM session_entry WHERE session_id = ${row.sessionId}),
					${row.type}, ${row.data}, ${row.label ?? null}, ${row.metadata ?? null},
					${row.createdAt}, ${row.updatedAt}
				)
			`,
		});

		// Single-row insert: toolCall and non-tool parts have different encoded
		// key sets (FieldOption omits absent keys), so multi-row sql.insert would
		// mix shapes. Parts per message are few; sequential inserts inside the
		// append transaction are fine.
		const insertPart = SqlSchema.void({
			Request: SessionEntryPartRow.insert,
			execute: (row) => sql`INSERT INTO session_entry_part ${sql.insert(row)}`,
		});

		// Root→leaf in one query: a parent always exists before its child, so a
		// parent's seq is always smaller and ORDER BY seq returns root-first.
		const selectPath = SqlSchema.findAll({
			Request: Schema.String,
			Result: SessionEntryRow,
			execute: (leafEntryId) => sql`
				WITH RECURSIVE path AS (
					SELECT * FROM session_entry WHERE id = ${leafEntryId}
					UNION ALL
					SELECT e.* FROM session_entry e
					JOIN path p ON e.id = p.parent_id AND e.session_id = p.session_id
				)
				SELECT * FROM path ORDER BY seq
			`,
		});

		// Recovery/import fallback when session.leaf_entry_id is NULL (§4.1).
		const selectLatestEntry = SqlSchema.findOneOption({
			Request: Schema.String,
			Result: SessionEntryRow,
			execute: (sessionId) => sql`
				SELECT * FROM session_entry WHERE session_id = ${sessionId} ORDER BY seq DESC LIMIT 1
			`,
		});

		const selectTimelinePage = SqlSchema.findAll({
			Request: Schema.Struct({
				sessionId: Schema.String,
				cursorSeq: Schema.NullOr(Schema.Int),
				limit: Schema.Int,
			}),
			Result: SessionEntryRow,
			execute: (r) => sql`
				SELECT * FROM session_entry
				WHERE session_id = ${r.sessionId} AND (${r.cursorSeq} IS NULL OR seq < ${r.cursorSeq})
				ORDER BY seq DESC LIMIT ${r.limit}
			`,
		});

		const selectPartsForEntries = SqlSchema.findAll({
			Request: Schema.Array(Schema.String),
			Result: SessionEntryPartRow,
			execute: (entryIds) => sql`
				SELECT * FROM session_entry_part
				WHERE ${sql.in("entry_id", entryIds)}
				ORDER BY entry_id, part_index
			`,
		});

		const selectUnsettled = SqlSchema.findAll({
			Request: Schema.String,
			Result: SessionEntryPartRow,
			execute: (sessionId) => sql`
				SELECT * FROM session_entry_part
				WHERE session_id = ${sessionId} AND status IN ('pending', 'running')
				ORDER BY entry_id, part_index
			`,
		});

		const epochNow = Effect.map(DateTime.now, DateTime.toEpochMillis);

		// Zip rule (§7.2): group parts by entry id, attach while walking entries.
		// entry.type says whether parts are expected; a mismatch is corruption,
		// not an edge case (§10.4).
		const hydrate = (
			entries: ReadonlyArray<SessionEntryRow>,
			parts: ReadonlyArray<SessionEntryPartRow>,
		): HydratedEntry[] => {
			const byEntry = new Map<string, SessionEntryPartRow[]>();
			for (const part of parts) {
				const bucket = byEntry.get(part.entryId);
				if (bucket) bucket.push(part);
				else byEntry.set(part.entryId, [part]);
			}
			return entries.map((entry) => ({ entry, parts: byEntry.get(entry.id) ?? [] }));
		};

		const partsFor = Effect.fnUntraced(function* (entries: ReadonlyArray<SessionEntryRow>) {
			const ids = entries.filter((entry) => messageTypes.has(entry.type)).map((entry) => entry.id);
			if (ids.length === 0) return [];
			return yield* selectPartsForEntries(ids).pipe(Effect.orDie);
		});

		const create = Effect.fn("Session.create")(function* (input: CreateSession) {
			const id = input.id ?? uuidv7();
			const row = yield* SessionRow.insert
				.makeEffect({
					id,
					projectId: input.projectId,
					parentId: Option.fromUndefinedOr(input.parentId),
					slug: input.slug,
					directory: input.directory,
					title: input.title,
					tag: input.tag,
					metadata: Option.fromUndefinedOr(input.metadata as Record<string, string> | undefined),
					leafEntryId: Option.none(),
				})
				.pipe(Effect.orDie);
			yield* insertSession(row).pipe(Effect.orDie);
			const created = yield* findSession(id).pipe(Effect.orDie);
			if (Option.isNone(created)) {
				return yield* Effect.die(new Error("session insert did not persist"));
			}
			return created.value;
		});

		const get = Effect.fn("Session.get")(function* (sessionId: string) {
			return yield* findSession(sessionId).pipe(Effect.orDie);
		});

		const list = Effect.fn("Session.list")(function* (input: { projectId: string }) {
			return yield* selectSessions(input.projectId).pipe(Effect.orDie);
		});

		const entry = Effect.fn("Session.entry")(function* (entryId: string) {
			const found = yield* findEntry(entryId).pipe(Effect.orDie);
			if (Option.isNone(found)) return Option.none<HydratedEntry>();
			const parts = yield* partsFor([found.value]);
			return Option.some(hydrate([found.value], parts)[0]!);
		});

		const resolveLeaf = Effect.fnUntraced(function* (session: SessionRow) {
			if (Option.isSome(session.leafEntryId)) return session.leafEntryId;
			const latest = yield* selectLatestEntry(session.id).pipe(Effect.orDie);
			return Option.map(latest, (row) => row.id);
		});

		const path = Effect.fn("Session.path")(function* (sessionId: string) {
			const session = yield* findSession(sessionId).pipe(Effect.orDie);
			if (Option.isNone(session)) return [];
			const leaf = yield* resolveLeaf(session.value);
			if (Option.isNone(leaf)) return [];
			const entries = yield* selectPath(leaf.value).pipe(Effect.orDie);
			const parts = yield* partsFor(entries);
			return hydrate(entries, parts);
		});

		const timeline = Effect.fn("Session.timeline")(function* (input: {
			sessionId: string;
			cursorSeq?: number;
			limit?: number;
		}) {
			const entries = yield* selectTimelinePage({
				sessionId: input.sessionId,
				cursorSeq: input.cursorSeq ?? null,
				limit: input.limit ?? 50,
			}).pipe(Effect.orDie);
			const parts = yield* partsFor(entries);
			return hydrate(entries, parts);
		});

		const unsettled = Effect.fn("Session.unsettled")(function* (sessionId: string) {
			return yield* selectUnsettled(sessionId).pipe(Effect.orDie);
		});

		type AppendTxResult =
			| { readonly _tag: "sessionNotFound" }
			| { readonly _tag: "parentNotFound" }
			| { readonly _tag: "leafConflict"; readonly actualLeafEntryId: string | null }
			| { readonly _tag: "inserted"; readonly entry: SessionEntryRow };

		const append = Effect.fn("Session.append")(function* (input: AppendEntry) {
			const parts = input.parts ?? [];
			if (parts.length > 0 && !messageTypes.has(input.type)) {
				return yield* new InvalidEntryDataError({
					entryId: input.id,
					type: input.type,
					reason: `entry type "${input.type}" must not carry parts`,
				});
			}

			// The envelope is authoritative; aggregate deltas are never accepted
			// independently of the data persisted by this transaction.
			const usage =
				input.type === "assistant"
					? yield* decodeEnvelopeUsage(input.data).pipe(
							Effect.map((envelope) => envelope.usage),
							Effect.mapError(
								(error) =>
									new InvalidEntryDataError({ entryId: input.id, type: input.type, reason: error.message }),
							),
						)
					: undefined;

			const result: AppendTxResult = yield* sql
				.withTransaction(
					Effect.gen(function* () {
						const session = yield* findSession(input.sessionId);
						if (Option.isNone(session)) return { _tag: "sessionNotFound" } as const;
						const currentLeaf = yield* resolveLeaf(session.value);
						// this might feel a bit redundant; but it's a way for the node
						// to make sure it appends only on known leaf entry, making sure the
						// assumption is correct.
						// Otherwise the assumption is wrong and state has changed.
						if (input.expectedLeafEntryId !== undefined) {
							const actualLeafEntryId = Option.getOrNull(currentLeaf);
							if (actualLeafEntryId !== input.expectedLeafEntryId) {
								return { _tag: "leafConflict", actualLeafEntryId } as const;
							}
						}

						// Append anchor: explicit branch target
						// (validated same-session; the composite FK is the schema backstop),
						// else the current leaf resolved with the same fallback reads use (§4.1).
						let parentId: Option.Option<string>;
						if (input.parentId !== undefined) {
							const rows = yield* sql`
								SELECT id FROM session_entry
								WHERE id = ${input.parentId} AND session_id = ${input.sessionId}
							`;
							if (rows.length === 0) return { _tag: "parentNotFound" } as const;
							parentId = Option.some(input.parentId);
						} else {
							parentId = currentLeaf;
						}

						const entryRow = yield* SessionEntryRow.insert.makeEffect({
							id: input.id,
							sessionId: input.sessionId,
							parentId,
							type: input.type,
							data: input.data,
							label: Option.none(),
							metadata: Option.none(),
						});
						yield* insertEntry(entryRow);

						for (const [partIndex, part] of parts.entries()) {
							const partRow = yield* SessionEntryPartRow.insert.makeEffect({
								id: part.id ?? uuidv7(),
								entryId: input.id,
								sessionId: input.sessionId,
								partIndex,
								type: part.type,
								status: Option.fromUndefinedOr(part.status),
								callId: Option.fromUndefinedOr(part.callId),
								toolName: Option.fromUndefinedOr(part.toolName),
								data: part.data,
							});
							yield* insertPart(partRow);
						}

						// Advance the cursor; assistant appends bump the usage aggregates
						// in the same statement (envelope usage is final at message.end).
						const now = yield* epochNow;
						yield* sql`
							UPDATE session SET
								leaf_entry_id = ${input.id},
								updated_at = ${now},
								cost = cost + ${usage?.cost.total ?? 0},
								tokens_input = tokens_input + ${usage?.input ?? 0},
								tokens_output = tokens_output + ${usage?.output ?? 0},
								tokens_cache_read = tokens_cache_read + ${usage?.cacheRead ?? 0},
								tokens_cache_write = tokens_cache_write + ${usage?.cacheWrite ?? 0}
							WHERE id = ${input.sessionId}
						`;

						const entry = yield* findEntry(input.id);
						if (Option.isNone(entry)) {
							return yield* Effect.die(new Error("session append: inserted entry did not persist"));
						}
						return { _tag: "inserted", entry: entry.value } as const;
					}),
				)
				.pipe(Effect.orDie);

			switch (result._tag) {
				case "sessionNotFound":
					return yield* new SessionNotFoundError({ sessionId: input.sessionId });
				case "parentNotFound":
					return yield* new EntryNotFoundError({ sessionId: input.sessionId, entryId: input.parentId ?? "" });
				case "leafConflict":
					return yield* new LeafConflictError({
						sessionId: input.sessionId,
						expectedLeafEntryId: input.expectedLeafEntryId ?? null,
						actualLeafEntryId: result.actualLeafEntryId,
					});
				case "inserted":
					return result.entry;
			}
		});

		const settleToolCall = Effect.fn("Session.settleToolCall")(function* (input: SettleToolCall) {
			const settled = yield* sql
				.withTransaction(
					Effect.gen(function* () {
						const rows = yield* sql`
							SELECT id FROM session_entry_part
							WHERE entry_id = ${input.entryId} AND call_id = ${input.callId} AND type = 'toolCall'
						`;
						if (rows.length === 0) return false;
						const now = yield* epochNow;
						yield* sql`
							UPDATE session_entry_part
							SET data = ${input.data}, status = ${input.status}, updated_at = ${now}
							WHERE entry_id = ${input.entryId} AND call_id = ${input.callId} AND type = 'toolCall'
						`;
						return true;
					}),
				)
				.pipe(Effect.orDie);

			if (!settled) {
				return yield* new ToolCallNotFoundError({ entryId: input.entryId, callId: input.callId });
			}
		});

		const branch = Effect.fn("Session.branch")(function* (input: { sessionId: string; entryId: string }) {
			const moved = yield* sql
				.withTransaction(
					Effect.gen(function* () {
						const rows = yield* sql`
							SELECT id FROM session_entry WHERE id = ${input.entryId} AND session_id = ${input.sessionId}
						`;
						if (rows.length === 0) return false;
						const now = yield* epochNow;
						yield* sql`
							UPDATE session SET leaf_entry_id = ${input.entryId}, updated_at = ${now}
							WHERE id = ${input.sessionId}
						`;
						return true;
					}),
				)
				.pipe(Effect.orDie);

			if (!moved) {
				return yield* new EntryNotFoundError({ sessionId: input.sessionId, entryId: input.entryId });
			}
		});

		const setLabel = Effect.fn("Session.setLabel")(function* (input: {
			sessionId: string;
			entryId: string;
			label: string | null;
		}) {
			const labeled = yield* sql
				.withTransaction(
					Effect.gen(function* () {
						const rows = yield* sql`
							SELECT id FROM session_entry WHERE id = ${input.entryId} AND session_id = ${input.sessionId}
						`;
						if (rows.length === 0) return false;
						const now = yield* epochNow;
						yield* sql`
							UPDATE session_entry SET label = ${input.label}, updated_at = ${now}
							WHERE id = ${input.entryId}
						`;
						return true;
					}),
				)
				.pipe(Effect.orDie);

			if (!labeled) {
				return yield* new EntryNotFoundError({ sessionId: input.sessionId, entryId: input.entryId });
			}
		});

		return Service.of({
			create,
			get,
			list,
			entry,
			path,
			timeline,
			unsettled,
			append,
			settleToolCall,
			branch,
			setLabel,
		});
	}),
);

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer));

export * as Session from "./session";
