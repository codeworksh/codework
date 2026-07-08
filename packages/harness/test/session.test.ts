import { Effect, Exit, Layer, Option } from "effect";
import path from "node:path";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it as vitestIt } from "vite-plus/test";
import { Database } from "../src/db/db";
import { AbsolutePath } from "../src/schema";
import { Session } from "../src/session/session";
import { tmpdir } from "./fixtures/tempdir";
import { testEffect } from "./utils/effect";

// Fresh in-memory database per test: the layer is rebuilt for every it.effect.
const layer = Session.layer.pipe(Layer.provideMerge(Database.layer(":memory:")));
const it = testEffect(layer);

const createSession = (slug: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		// session.project_id references project(id)
		yield* sql`INSERT OR IGNORE INTO project (id, name, created_at, updated_at) VALUES ('local', 'local', 0, 0)`;

		const session = yield* Session.Service;
		return yield* session.create({
			projectId: "local",
			slug,
			directory: AbsolutePath.make("/repo"),
			title: "Test session",
			tag: "test",
		});
	});

const userEntry = (sessionId: string, id: string, text: string): Session.AppendEntry => ({
	id,
	sessionId,
	type: "user",
	data: JSON.stringify({ messageId: id, role: "user", time: { created: 1 } }),
	parts: [{ type: "text", data: JSON.stringify({ type: "text", text }) }],
});

const assistantEntry = (
	sessionId: string,
	id: string,
	options?: { usage?: Session.Usage; toolCall?: { callId: string; toolName: string } },
): Session.AppendEntry => ({
	id,
	sessionId,
	type: "assistant",
	data: JSON.stringify({ messageId: id, role: "assistant", stopReason: "stop" }),
	parts: [
		{ type: "text", data: JSON.stringify({ type: "text", text: "ok" }) },
		...(options?.toolCall
			? [
					{
						type: "toolCall" as const,
						status: "pending" as const,
						callId: options.toolCall.callId,
						toolName: options.toolCall.toolName,
						data: JSON.stringify({
							type: "toolCall",
							callID: options.toolCall.callId,
							name: options.toolCall.toolName,
							status: "pending",
						}),
					},
				]
			: []),
	],
	usage: options?.usage,
});

const countOf = (rows: ReadonlyArray<unknown>) => {
	const row = rows[0] as { count?: number | bigint } | undefined;
	return Number(row?.count ?? 0);
};

describe("session", () => {
	it.effect("create + get round-trips the session row", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-create");

			const found = yield* session.get(created.id);
			expect(Option.isSome(found)).toBe(true);
			const row = Option.getOrElse(found, () => created);
			expect(row.slug).toBe("s-create");
			expect(row.cost).toBe(0);
			expect(row.tokensInput).toBe(0);
			expect(Option.isNone(row.leafEntryId)).toBe(true);

			const listed = yield* session.list({ projectId: "local" });
			expect(listed.map((r) => r.id)).toContain(created.id);
		}),
	);

	it.effect("append advances the leaf and produces dense seq", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-append");

			const first = yield* session.append(userEntry(created.id, "e1", "hello"));
			const second = yield* session.append(assistantEntry(created.id, "e2"));

			expect(first.seq).toBe(1);
			expect(second.seq).toBe(2);
			expect(Option.isNone(first.parentId)).toBe(true);
			expect(Option.getOrElse(second.parentId, () => "")).toBe("e1");

			const after = yield* session.get(created.id);
			const leaf = Option.flatMap(after, (row) => row.leafEntryId);
			expect(Option.getOrElse(leaf, () => "")).toBe("e2");
		}),
	);

	it.effect("append to a missing session fails typed", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const result = yield* session.append(userEntry("nope", "e1", "hi")).pipe(Effect.flip);
			expect(result._tag).toBe("SessionNotFoundError");
		}),
	);

	it.effect("assistant appends bump the session usage aggregates", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-usage");

			yield* session.append(userEntry(created.id, "e1", "hi"));
			yield* session.append(
				assistantEntry(created.id, "e2", {
					usage: { input: 100, output: 20, cacheRead: 40, cacheWrite: 10, costTotal: 0.5 },
				}),
			);
			yield* session.append(userEntry(created.id, "e3", "again"));
			yield* session.append(
				assistantEntry(created.id, "e4", {
					usage: { input: 150, output: 30, cacheRead: 90, cacheWrite: 0, costTotal: 0.25 },
				}),
			);

			const row = Option.getOrElse(yield* session.get(created.id), () => created);
			expect(row.tokensInput).toBe(250);
			expect(row.tokensOutput).toBe(50);
			expect(row.tokensCacheRead).toBe(130);
			expect(row.tokensCacheWrite).toBe(10);
			expect(row.cost).toBeCloseTo(0.75);
		}),
	);

	it.effect("path walks root→leaf across a branch point", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-branch");

			yield* session.append(userEntry(created.id, "e1", "start"));
			yield* session.append(assistantEntry(created.id, "e2"));
			yield* session.append(userEntry(created.id, "e3", "approach A"));
			yield* session.append(assistantEntry(created.id, "e4"));

			// abandon A: move the leaf back to e2 and take approach B
			yield* session.branch({ sessionId: created.id, entryId: "e2" });
			yield* session.append(userEntry(created.id, "e5", "approach B"));

			const path = yield* session.path(created.id);
			expect(path.map((h) => h.entry.id)).toEqual(["e1", "e2", "e5"]);

			// abandoned branch stays queryable on the full timeline
			const timeline = yield* session.timeline({ sessionId: created.id });
			expect(timeline.map((h) => h.entry.id)).toEqual(["e5", "e4", "e3", "e2", "e1"]);

			// e5 is a sibling of e3 (both children of e2)
			const e5 = timeline.find((h) => h.entry.id === "e5")!;
			expect(Option.getOrElse(e5.entry.parentId, () => "")).toBe("e2");
		}),
	);

	it.effect("branch to a foreign entry fails typed", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const a = yield* createSession("s-branch-a");
			const b = yield* createSession("s-branch-b");
			yield* session.append(userEntry(a.id, "e1", "hi"));

			const result = yield* session.branch({ sessionId: b.id, entryId: "e1" }).pipe(Effect.flip);
			expect(result._tag).toBe("EntryNotFoundError");
		}),
	);

	it.effect("timeline attaches parts only to message entries and pages by seq", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-timeline");

			yield* session.append(userEntry(created.id, "e1", "hi"));
			yield* session.append(assistantEntry(created.id, "e2"));
			yield* session.append({
				id: "e3",
				sessionId: created.id,
				type: "compaction",
				data: JSON.stringify({ summary: "earlier work", firstKeptEntryId: "e1", tokensBefore: 1000 }),
			});

			const timeline = yield* session.timeline({ sessionId: created.id });
			const byId = new Map(timeline.map((h) => [h.entry.id, h]));
			expect(byId.get("e1")!.parts).toHaveLength(1);
			expect(byId.get("e2")!.parts).toHaveLength(1);
			expect(byId.get("e3")!.parts).toHaveLength(0);
			expect(byId.get("e1")!.parts[0]!.partIndex).toBe(0);

			// newest-first pagination: page of 2, then cursor
			const page1 = yield* session.timeline({ sessionId: created.id, limit: 2 });
			expect(page1.map((h) => h.entry.id)).toEqual(["e3", "e2"]);
			const cursor = page1[page1.length - 1]!.entry.seq;
			const page2 = yield* session.timeline({ sessionId: created.id, cursorSeq: cursor, limit: 2 });
			expect(page2.map((h) => h.entry.id)).toEqual(["e1"]);
		}),
	);

	it.effect("settleToolCall mutates exactly one part and drains unsettled", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-settle");

			yield* session.append(userEntry(created.id, "e1", "read a file"));
			yield* session.append(assistantEntry(created.id, "e2", { toolCall: { callId: "call_1", toolName: "read" } }));

			const pending = yield* session.unsettled(created.id);
			expect(pending).toHaveLength(1);
			expect(Option.getOrElse(pending[0]!.callId, () => "")).toBe("call_1");

			yield* session.settleToolCall({
				entryId: "e2",
				callId: "call_1",
				status: "completed",
				data: JSON.stringify({
					type: "toolCall",
					callID: "call_1",
					name: "read",
					status: "completed",
					result: { content: [{ type: "text", text: "{}" }], isError: false },
				}),
			});

			expect(yield* session.unsettled(created.id)).toHaveLength(0);

			const hydrated = Option.getOrElse(yield* session.entry("e2"), () => {
				throw new Error("entry missing");
			});
			const tool = hydrated.parts.find((p) => p.type === "toolCall")!;
			expect(Option.getOrElse(tool.status, () => "")).toBe("completed");
			expect(JSON.parse(tool.data).status).toBe("completed");
			// sibling text part untouched
			const text = hydrated.parts.find((p) => p.type === "text")!;
			expect(JSON.parse(text.data).text).toBe("ok");
		}),
	);

	it.effect("settleToolCall on an unknown call fails typed", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-settle-missing");
			yield* session.append(userEntry(created.id, "e1", "hi"));

			const result = yield* session
				.settleToolCall({ entryId: "e1", callId: "call_x", status: "error", data: "{}" })
				.pipe(Effect.flip);
			expect(result._tag).toBe("ToolCallNotFoundError");
		}),
	);

	it.effect("setLabel sets and clears the bookmark", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-label");
			yield* session.append(userEntry(created.id, "e1", "hi"));

			yield* session.setLabel({ sessionId: created.id, entryId: "e1", label: "important" });
			let hydrated = yield* session.entry("e1");
			expect(Option.flatMap(hydrated, (h) => h.entry.label).pipe(Option.getOrElse(() => ""))).toBe("important");

			yield* session.setLabel({ sessionId: created.id, entryId: "e1", label: null });
			hydrated = yield* session.entry("e1");
			expect(Option.isNone(Option.flatMap(hydrated, (h) => h.entry.label))).toBe(true);
		}),
	);

	it.effect("append validates an explicit parentId against the session", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const a = yield* createSession("s-parent-a");
			const b = yield* createSession("s-parent-b");
			yield* session.append(userEntry(a.id, "ea1", "in session a"));
			yield* session.append(userEntry(b.id, "eb1", "in session b"));

			// cross-session parent is rejected typed
			const result = yield* session
				.append({ ...userEntry(b.id, "eb2", "bad parent"), parentId: "ea1" })
				.pipe(Effect.flip);
			expect(result._tag).toBe("EntryNotFoundError");

			// same-session explicit parent works (sibling branch append)
			const sibling = yield* session.append({ ...userEntry(b.id, "eb3", "good parent"), parentId: "eb1" });
			expect(Option.getOrElse(sibling.parentId, () => "")).toBe("eb1");
		}),
	);

	it.effect("append falls back to the latest entry when the leaf pointer is lost", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const session = yield* Session.Service;
			const created = yield* createSession("s-leaf-lost");
			yield* session.append(userEntry(created.id, "e1", "hi"));
			yield* session.append(assistantEntry(created.id, "e2"));

			// simulate imported/recovered state: entries exist, cursor lost
			yield* sql`UPDATE session SET leaf_entry_id = NULL WHERE id = ${created.id}`;

			const third = yield* session.append(userEntry(created.id, "e3", "resume"));
			expect(Option.getOrElse(third.parentId, () => "")).toBe("e2");

			const path = yield* session.path(created.id);
			expect(path.map((h) => h.entry.id)).toEqual(["e1", "e2", "e3"]);
		}),
	);

	it.effect("duplicate call ids within an entry are rejected by the schema", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-dup-call");

			const toolPart = (callId: string): Session.AppendPart => ({
				type: "toolCall",
				status: "pending",
				callId,
				toolName: "read",
				data: JSON.stringify({ type: "toolCall", callID: callId, name: "read", status: "pending" }),
			});

			const exit = yield* session
				.append({
					id: "e1",
					sessionId: created.id,
					type: "assistant",
					data: JSON.stringify({ messageId: "e1", role: "assistant" }),
					parts: [toolPart("call_dup"), toolPart("call_dup")],
				})
				.pipe(Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);

			// the failed transaction rolled back whole — no partial entry
			expect(Option.isNone(yield* session.entry("e1"))).toBe(true);
		}),
	);

	it.effect("usage on a non-assistant entry is a defect", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-usage-guard");

			const exit = yield* session
				.append({
					...userEntry(created.id, "e1", "hi"),
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costTotal: 0.1 },
				})
				.pipe(Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);

			// nothing was written
			expect(Option.isNone(yield* session.entry("e1"))).toBe(true);
			const row = Option.getOrElse(yield* session.get(created.id), () => created);
			expect(row.cost).toBe(0);
		}),
	);

	it.effect("schema rejects cross-session parent edges", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const session = yield* Session.Service;
			const a = yield* createSession("s-fk-parent-a");
			const b = yield* createSession("s-fk-parent-b");
			yield* session.append(userEntry(a.id, "ea1", "in session a"));
			yield* session.append(userEntry(b.id, "eb1", "in session b"));

			const exit = yield* sql`
				INSERT INTO session_entry (id, session_id, parent_id, seq, type, data, created_at, updated_at)
				VALUES ('eb_bad', ${b.id}, 'ea1', 2, 'user', '{}', 0, 0)
			`.pipe(Effect.exit);

			expect(Exit.isFailure(exit)).toBe(true);
			expect(Option.isNone(yield* session.entry("eb_bad"))).toBe(true);
		}),
	);

	it.effect("schema rejects parts whose session does not own the entry", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const session = yield* Session.Service;
			const a = yield* createSession("s-fk-part-a");
			const b = yield* createSession("s-fk-part-b");
			yield* session.append(userEntry(a.id, "ea1", "in session a"));

			const exit = yield* sql`
				INSERT INTO session_entry_part
					(id, entry_id, session_id, part_index, type, data, created_at, updated_at)
				VALUES ('p_bad', 'ea1', ${b.id}, 0, 'text', '{}', 0, 0)
			`.pipe(Effect.exit);

			expect(Exit.isFailure(exit)).toBe(true);
			const rows = yield* sql`SELECT count(*) AS count FROM session_entry_part WHERE id = 'p_bad'`;
			expect(countOf(rows)).toBe(0);
		}),
	);

	it.effect("schema enforces toolCall promoted-column shape", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const session = yield* Session.Service;
			const created = yield* createSession("s-check-tool-shape");
			yield* session.append(assistantEntry(created.id, "e1"));

			const nonToolWithStatus = yield* sql`
				INSERT INTO session_entry_part
					(id, entry_id, session_id, part_index, type, status, data, created_at, updated_at)
				VALUES ('p_text_bad', 'e1', ${created.id}, 10, 'text', 'pending', '{}', 0, 0)
			`.pipe(Effect.exit);

			const toolMissingCall = yield* sql`
				INSERT INTO session_entry_part
					(id, entry_id, session_id, part_index, type, status, tool_name, data, created_at, updated_at)
				VALUES ('p_tool_bad', 'e1', ${created.id}, 11, 'toolCall', 'pending', 'read', '{}', 0, 0)
			`.pipe(Effect.exit);

			expect(Exit.isFailure(nonToolWithStatus)).toBe(true);
			expect(Exit.isFailure(toolMissingCall)).toBe(true);
			const rows = yield* sql`
				SELECT count(*) AS count FROM session_entry_part WHERE id IN ('p_text_bad', 'p_tool_bad')
			`;
			expect(countOf(rows)).toBe(0);
		}),
	);

	it.effect("schema cascades whole-session deletes through entries and parts", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const session = yield* Session.Service;
			const created = yield* createSession("s-cascade");
			yield* session.append(userEntry(created.id, "e1", "hi"));
			yield* session.append(assistantEntry(created.id, "e2", { toolCall: { callId: "call_1", toolName: "read" } }));

			yield* sql`DELETE FROM session WHERE id = ${created.id}`;

			const entries = yield* sql`SELECT count(*) AS count FROM session_entry WHERE session_id = ${created.id}`;
			const parts = yield* sql`SELECT count(*) AS count FROM session_entry_part WHERE session_id = ${created.id}`;
			expect(countOf(entries)).toBe(0);
			expect(countOf(parts)).toBe(0);
		}),
	);

	it.effect("migration creates the session-entry tables and indexes", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const rows = yield* sql`
				SELECT name FROM sqlite_master
				WHERE type IN ('table', 'index')
					AND name IN (
						'session_entry',
						'session_entry_part',
						'session_entry_session_id_idx',
						'session_entry_session_seq_idx',
						'session_entry_parent_idx',
						'session_entry_type_idx',
						'session_entry_label_idx',
						'session_entry_part_entry_idx',
						'session_entry_part_call_idx',
						'session_entry_part_call_uidx',
						'session_entry_part_unsettled_idx',
						'session_entry_part_session_idx'
					)
			`;
			const names = new Set(rows.map((row) => (row as { name: string }).name));
			expect(names).toEqual(
				new Set([
					"session_entry",
					"session_entry_part",
					"session_entry_session_id_idx",
					"session_entry_session_seq_idx",
					"session_entry_parent_idx",
					"session_entry_type_idx",
					"session_entry_label_idx",
					"session_entry_part_entry_idx",
					"session_entry_part_call_idx",
					"session_entry_part_call_uidx",
					"session_entry_part_unsettled_idx",
					"session_entry_part_session_idx",
				]),
			);
		}),
	);

	it.effect("failed DB constraint inside append-like transaction rolls back the entry", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const created = yield* createSession("s-rollback-check");

			const exit = yield* sql
				.withTransaction(
					Effect.gen(function* () {
						yield* sql`
							INSERT INTO session_entry (id, session_id, parent_id, seq, type, data, created_at, updated_at)
							VALUES ('e_bad', ${created.id}, NULL, 1, 'assistant', '{}', 0, 0)
						`;
						yield* sql`
							INSERT INTO session_entry_part
								(id, entry_id, session_id, part_index, type, status, data, created_at, updated_at)
							VALUES ('p_bad', 'e_bad', ${created.id}, 0, 'text', 'pending', '{}', 0, 0)
						`;
					}),
				)
				.pipe(Effect.exit);

			expect(Exit.isFailure(exit)).toBe(true);
			const entries = yield* sql`SELECT count(*) AS count FROM session_entry WHERE id = 'e_bad'`;
			const parts = yield* sql`SELECT count(*) AS count FROM session_entry_part WHERE id = 'p_bad'`;
			expect(countOf(entries)).toBe(0);
			expect(countOf(parts)).toBe(0);
		}),
	);

	vitestIt("persists session entries across a file database reload", async () => {
		await using tmp = await tmpdir();
		const database = path.join(tmp.path, "session.db");
		const fileLayer = Session.layer.pipe(Layer.provideMerge(Database.layer(database)));

		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT OR IGNORE INTO project (id, name, created_at, updated_at) VALUES ('local', 'local', 0, 0)`;

				const session = yield* Session.Service;
				yield* session.create({
					id: "persisted-session",
					projectId: "local",
					slug: "s-file-reload",
					directory: AbsolutePath.make("/repo"),
					title: "Persisted session",
					tag: "test",
				});
				yield* session.append(userEntry("persisted-session", "e1", "hello"));
				yield* session.append(assistantEntry("persisted-session", "e2"));
			}).pipe(Effect.scoped, Effect.provide(fileLayer)),
		);

		const ids = await Effect.runPromise(
			Effect.gen(function* () {
				const session = yield* Session.Service;
				const path = yield* session.path("persisted-session");
				return path.map((entry) => entry.entry.id);
			}).pipe(Effect.scoped, Effect.provide(fileLayer)),
		);

		expect(ids).toEqual(["e1", "e2"]);
	});
});
