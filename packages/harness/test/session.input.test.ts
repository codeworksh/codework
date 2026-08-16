import { DateTime, Effect, Exit, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { Database, SqlSchema } from "../src/db/db.ts";
import { inputDeliveries, SessionInputRow } from "../src/db/schema.sql.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { testEffect } from "./utils/effect.ts";

const { effect: it } = testEffect(Database.layer(":memory:"));

const PendingInput = Schema.Struct({
	sessionId: Schema.String,
	delivery: Schema.Literals(inputDeliveries),
});

const queries = (sql: SqlClient.SqlClient) => ({
	insert: SqlSchema.void({
		Request: SessionInputRow.insert,
		execute: (row) => sql`INSERT INTO session_input ${sql.insert(row)}`,
	}),
	pendingAll: SqlSchema.findAll({
		Request: PendingInput,
		Result: SessionInputRow,
		execute: ({ sessionId, delivery }) => sql`
			SELECT * FROM session_input
			WHERE session_id = ${sessionId}
				AND promoted_seq IS NULL
				AND delivery = ${delivery}
			ORDER BY admitted_seq
		`,
	}),
	pendingOne: SqlSchema.findAll({
		Request: PendingInput,
		Result: SessionInputRow,
		execute: ({ sessionId, delivery }) => sql`
			SELECT * FROM session_input
			WHERE session_id = ${sessionId}
				AND promoted_seq IS NULL
				AND delivery = ${delivery}
			ORDER BY admitted_seq
			LIMIT 1
		`,
	}),
});

const createSession = Effect.fn("SessionInputTest.createSession")(function* (id: string) {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`INSERT OR IGNORE INTO project (id, name, created_at, updated_at) VALUES ('local', 'local', 0, 0)`;
	// NULL is the host, and the foreign key is skipped on NULL — so a session
	// needs no sandbox registered at all. An invented namespace would be rejected.
	yield* sql`
		INSERT INTO session (id, project_id, slug, directory, title, tag, sandbox_instance_id, created_at, updated_at)
		VALUES (${id}, 'local', ${id}, '/repo', 'Test session', 'test', NULL, 0, 0)
	`;
});

const makeInput = (input: {
	readonly id: string;
	readonly sessionId: string;
	readonly admittedSeq: number;
	readonly delivery: "steer" | "followUp";
}) =>
	SessionInputRow.insert.makeEffect({
		...input,
		// Fixture rows are seeded by raw SQL, so brand without the prefix check.
		sessionId: SessionSchema.IDFromDb.make(input.sessionId),
		prompt: { text: input.id },
		promotedSeq: Option.none(),
	});

describe("SessionInput", () => {
	it(
		"stores pending inputs and supports queue modes in admission order",
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const db = queries(sql);
			yield* createSession("session-1");

			yield* db.insert(
				yield* makeInput({ id: "follow-up-1", sessionId: "session-1", admittedSeq: 1, delivery: "followUp" }),
			);
			yield* db.insert(
				yield* makeInput({ id: "steer-1", sessionId: "session-1", admittedSeq: 2, delivery: "steer" }),
			);
			yield* db.insert(
				yield* makeInput({ id: "steer-2", sessionId: "session-1", admittedSeq: 3, delivery: "steer" }),
			);

			const one = yield* db.pendingOne({ sessionId: "session-1", delivery: "steer" });
			const all = yield* db.pendingAll({ sessionId: "session-1", delivery: "steer" });

			expect(one.map((row) => row.id)).toEqual(["steer-1"]);
			expect(all.map((row) => row.id)).toEqual(["steer-1", "steer-2"]);
			expect(Option.isNone(all[0]?.promotedSeq ?? Option.none())).toBe(true);
			expect(DateTime.isDateTime(all[0]?.createdAt)).toBe(true);

			yield* sql`UPDATE session_input SET promoted_seq = 1 WHERE id = 'steer-1'`;
			const remaining = yield* db.pendingAll({ sessionId: "session-1", delivery: "steer" });
			expect(remaining.map((row) => row.id)).toEqual(["steer-2"]);
		}),
	);

	it(
		"enforces per-session admission and promotion order",
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const db = queries(sql);
			yield* createSession("session-1");
			yield* createSession("session-2");

			yield* db.insert(
				yield* makeInput({ id: "input-1", sessionId: "session-1", admittedSeq: 1, delivery: "steer" }),
			);
			yield* db.insert(
				yield* makeInput({ id: "input-2", sessionId: "session-1", admittedSeq: 2, delivery: "steer" }),
			);

			const duplicateAdmission = yield* db
				.insert(yield* makeInput({ id: "input-3", sessionId: "session-1", admittedSeq: 1, delivery: "followUp" }))
				.pipe(Effect.exit);
			expect(Exit.isFailure(duplicateAdmission)).toBe(true);

			yield* sql`UPDATE session_input SET promoted_seq = 1 WHERE id = 'input-1'`;
			const duplicatePromotion = yield* sql`
				UPDATE session_input SET promoted_seq = 1 WHERE id = 'input-2'
			`.pipe(Effect.exit);
			expect(Exit.isFailure(duplicatePromotion)).toBe(true);

			// Sequences are scoped to a session, not global queue counters.
			yield* db.insert(
				yield* makeInput({ id: "input-4", sessionId: "session-2", admittedSeq: 1, delivery: "followUp" }),
			);
			yield* sql`UPDATE session_input SET promoted_seq = 1 WHERE id = 'input-4'`;
		}),
	);

	it(
		"cascades with its session and has no SessionEntry foreign key",
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const db = queries(sql);
			yield* createSession("session-1");
			yield* db.insert(
				yield* makeInput({ id: "input-1", sessionId: "session-1", admittedSeq: 1, delivery: "followUp" }),
			);
			// An input id becomes the entry id once promoted, so the two share a
			// namespace -- but that is enforced by SessionInput.projectAdmitted, not
			// by the schema. The only foreign key here is the session.
			const foreignKeys = yield* sql`PRAGMA foreign_key_list(session_input)`;
			expect(foreignKeys.map((row) => (row as { table: string }).table)).toEqual(["session"]);

			yield* sql`DELETE FROM session WHERE id = 'session-1'`;
			const rows = yield* sql`SELECT id FROM session_input`;
			expect(rows).toEqual([]);

			const orphan = yield* sql`
				INSERT INTO session_input
					(id, session_id, prompt, delivery, admitted_seq, created_at)
				VALUES ('orphan', 'missing', '{"text":""}', 'steer', 1, 0)
			`.pipe(Effect.exit);
			expect(Exit.isFailure(orphan)).toBe(true);
		}),
	);

	it(
		"migration creates the input table and indexes",
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const objects = yield* sql`
				SELECT name FROM sqlite_master
				WHERE type IN ('table', 'index')
					AND name IN (
						'session_input',
						'session_input_pending_idx',
						'session_input_admitted_seq_idx',
						'session_input_promoted_seq_idx'
					)
			`;
			const names = new Set(objects.map((row) => (row as { name: string }).name));
			expect(names).toEqual(
				new Set([
					"session_input",
					"session_input_pending_idx",
					"session_input_admitted_seq_idx",
					"session_input_promoted_seq_idx",
				]),
			);

			const columns = yield* sql`PRAGMA table_info(session_input)`;
			expect(columns.map((row) => (row as { name: string }).name)).toEqual([
				"id",
				"session_id",
				"prompt",
				"delivery",
				"admitted_seq",
				"promoted_seq",
				"created_at",
			]);
		}),
	);
});
