import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { uuidv7 } from "uuidv7";
import { DocumentRevisionRow, DocumentRow } from "../db/schema.sql.ts";
import type { SessionSchema } from "../session/schema.ts";
import type { ThreadSchema } from "../thread/schema.ts";
import { DocumentSchema } from "./schema.ts";

type Value = DocumentRevisionRow["value"];

export interface Revision {
	readonly seq: number;
	readonly version: number;
	readonly value: Value;
}

export interface CreateInput {
	readonly sessionId: SessionSchema.ID;
	/** Absent = session scope. */
	readonly threadId?: ThreadSchema.ID;
	readonly definition: DocumentSchema.Definition;
	readonly value: Value;
	/** The event that creates it; also its first revision's. */
	readonly seq: number;
}

export interface Interface {
	/** Projector-only: a document and its first revision, at one seq. */
	readonly create: (input: CreateInput) => Effect.Effect<DocumentRow>;
	/** The live document of a kind owned by a thread. */
	readonly find: (threadId: string, kind: string) => Effect.Effect<Option.Option<DocumentRow>>;
	/** A thread's live documents. */
	readonly ofThread: (threadId: string) => Effect.Effect<ReadonlyArray<DocumentRow>>;
	readonly current: (documentId: DocumentSchema.ID) => Effect.Effect<Option.Option<Revision>>;
	/** The value in effect at `seq`: the newest revision at or before it. */
	readonly asOf: (documentId: DocumentSchema.ID, seq: number) => Effect.Effect<Option.Option<Revision>>;
	/** Projector-only: a new full value at the event's seq. A `latest` document drops older revisions. */
	readonly write: (documentId: DocumentSchema.ID, revision: Revision) => Effect.Effect<void>;
	/** A thread's `agent` value now; `{}` when it has none. */
	readonly agent: (threadId: string) => Effect.Effect<DocumentSchema.Agent>;
	/** A thread's `agent` value as of a seq. */
	readonly agentAsOf: (threadId: string, seq: number) => Effect.Effect<DocumentSchema.Agent>;
	/**
	 * Projector-only: apply a change to a thread's `agent` and write the result at `seq`. Read and
	 * written in the event's transaction, so a concurrent change is never lost.
	 */
	readonly configure: (threadId: string, change: DocumentSchema.AgentChange, seq: number) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/document/document/Service") {}

const decodeAgent = Schema.decodeUnknownEffect(DocumentSchema.Agent);
const encodeAgent = Schema.encodeEffect(DocumentSchema.Agent);

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;

		const insertDocument = SqlSchema.void({
			Request: DocumentRow.insert,
			execute: (row) => sql`INSERT INTO document ${sql.insert(row)}`,
		});
		const insertRevision = SqlSchema.void({
			Request: DocumentRevisionRow.insert,
			execute: (row) => sql`INSERT INTO revision ${sql.insert(row)}`,
		});
		const findLive = SqlSchema.findOneOption({
			Request: Schema.Struct({ threadId: Schema.String, kind: Schema.String }),
			Result: DocumentRow,
			execute: ({ threadId, kind }) => sql`
				SELECT * FROM document WHERE thread_id = ${threadId} AND kind = ${kind} AND retired_seq IS NULL
			`,
		});
		const findById = SqlSchema.findOneOption({
			Request: Schema.String,
			Result: DocumentRow,
			execute: (id) => sql`SELECT * FROM document WHERE id = ${id}`,
		});
		const selectOfThread = SqlSchema.findAll({
			Request: Schema.String,
			Result: DocumentRow,
			execute: (threadId) => sql`
				SELECT * FROM document WHERE thread_id = ${threadId} AND retired_seq IS NULL ORDER BY created_seq
			`,
		});
		const selectRevision = SqlSchema.findOneOption({
			Request: Schema.Struct({ documentId: Schema.String, asOf: Schema.Int }),
			Result: DocumentRevisionRow,
			execute: ({ documentId, asOf }) => sql`
				SELECT * FROM revision WHERE document_id = ${documentId} AND seq <= ${asOf} ORDER BY seq DESC LIMIT 1
			`,
		});

		const toRevision = (row: DocumentRevisionRow): Revision => ({
			seq: row.seq,
			version: row.version,
			value: row.value,
		});

		const write = Effect.fn("Document.write")(function* (documentId: DocumentSchema.ID, revision: Revision) {
			yield* insertRevision({ documentId, ...revision });
			const document = yield* findById(documentId);
			if (Option.isSome(document) && Option.getOrUndefined(document.value.history) === "latest") {
				yield* sql`DELETE FROM revision WHERE document_id = ${documentId} AND seq < ${revision.seq}`;
			}
		}, Effect.orDie);

		const create = Effect.fn("Document.create")(function* (input: CreateInput) {
			const { definition } = input;
			const row = DocumentRow.insert.make({
				id: DocumentSchema.ID.make(uuidv7()),
				sessionId: input.sessionId,
				threadId: Option.fromUndefinedOr(input.threadId),
				kind: definition.kind,
				history: Option.fromUndefinedOr(definition.history),
				fork: Option.fromUndefinedOr(definition.fork),
				createdSeq: input.seq,
				retiredSeq: Option.none(),
			});
			yield* insertDocument(row);
			yield* write(row.id, { seq: input.seq, version: definition.version, value: input.value });
			return new DocumentRow(row);
		}, Effect.orDie);

		const find = Effect.fn("Document.find")(function* (threadId: string, kind: string) {
			return yield* findLive({ threadId, kind });
		}, Effect.orDie);

		const ofThread = Effect.fn("Document.ofThread")(function* (threadId: string) {
			return yield* selectOfThread(threadId);
		}, Effect.orDie);

		const asOf = Effect.fn("Document.asOf")(function* (documentId: DocumentSchema.ID, seq: number) {
			return Option.map(yield* selectRevision({ documentId, asOf: seq }), toRevision);
		}, Effect.orDie);

		const current = (documentId: DocumentSchema.ID) => asOf(documentId, Number.MAX_SAFE_INTEGER);

		const readAgent = Effect.fnUntraced(function* (threadId: string, seq: number) {
			const document = yield* find(threadId, DocumentSchema.agent.kind);
			if (Option.isNone(document)) return {};
			const revision = yield* asOf(document.value.id, seq);
			if (Option.isNone(revision)) return {};
			return yield* decodeAgent(revision.value.value).pipe(Effect.orDie);
		});

		const agent = Effect.fn("Document.agent")((threadId: string) => readAgent(threadId, Number.MAX_SAFE_INTEGER));
		const agentAsOf = Effect.fn("Document.agentAsOf")(readAgent);

		const configure = Effect.fn("Document.configure")(function* (
			threadId: string,
			change: DocumentSchema.AgentChange,
			seq: number,
		) {
			const document = yield* find(threadId, DocumentSchema.agent.kind);
			if (Option.isNone(document)) return yield* Effect.die(`thread ${threadId} has no agent document`);
			const next = DocumentSchema.applyAgentChange(yield* readAgent(threadId, Number.MAX_SAFE_INTEGER), change);
			yield* write(document.value.id, {
				seq,
				version: DocumentSchema.agent.version,
				value: yield* encodeAgent(next).pipe(Effect.orDie),
			});
		});

		return Service.of({ create, find, ofThread, current, asOf, write, agent, agentAsOf, configure });
	}),
);

export * as Document from "./document.ts";
