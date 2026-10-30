import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { Document } from "../src/document/document.ts";
import { Event } from "../src/event/event.ts";
import { AbsolutePath } from "../src/schema.ts";
import { SessionLive } from "../src/session/live.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { Session } from "../src/session/session.ts";
import { ThreadSchema } from "../src/thread/schema.ts";
import { Thread } from "../src/thread/thread.ts";
import { seedSpace } from "./fixtures/space.ts";
import { testEffect } from "./utils/effect.ts";

// Fresh in-memory database per test: the layer is rebuilt for every it.effect.
const layer = SessionLive.layer.pipe(Layer.provideMerge(Event.layer), Layer.provideMerge(Database.layer(":memory:")));
const it = testEffect(layer);

const createSession = (location?: string) =>
	Effect.gen(function* () {
		const { spaceId, location: directory } = yield* seedSpace(location === undefined ? {} : { location });
		const sessions = yield* Session.Service;
		const { session, thread } = yield* sessions.create({ spaceId, directory, title: "Test session", tag: "test" });
		return { sessionId: SessionSchema.ID.make(session.id), threadId: ThreadSchema.ID.make(thread.id) };
	});

// An entry's seq is the sequence of the event that produced it. These tests append directly, so
// each reserves its own position on the session's log, as an event would.
const nextSeq = (sessionId: SessionSchema.ID) =>
	Effect.gen(function* () {
		const events = yield* Event.Service;
		const seq = (yield* events.latestSequence(sessionId)) + 1;
		yield* events.advance(sessionId, seq);
		return seq;
	});

const userEntry = (threadId: ThreadSchema.ID, seq: number, id: string, text: string): Thread.AppendEntry => ({
	id,
	threadId,
	seq,
	type: "user",
	data: JSON.stringify({ messageId: id, role: "user", time: { created: 1 } }),
	parts: [{ type: "text", data: JSON.stringify({ type: "text", text }) }],
});

const usage = (
	input: Partial<Pick<SessionSchema.Usage, "input" | "output" | "cacheRead" | "cacheWrite">> & {
		readonly costTotal?: number;
	} = {},
): SessionSchema.Usage => {
	const tokens = {
		input: input.input ?? 0,
		output: input.output ?? 0,
		cacheRead: input.cacheRead ?? 0,
		cacheWrite: input.cacheWrite ?? 0,
	};
	return {
		...tokens,
		totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: input.costTotal ?? 0 },
	};
};

const assistantEntry = (
	threadId: ThreadSchema.ID,
	seq: number,
	id: string,
	options?: { usage?: SessionSchema.Usage },
): Thread.AppendEntry => ({
	id,
	threadId,
	seq,
	type: "assistant",
	data: JSON.stringify({
		messageId: id,
		role: "assistant",
		stopReason: "stop",
		usage: options?.usage ?? usage(),
	}),
	parts: [{ type: "text", data: JSON.stringify({ type: "text", text: "ok" }) }],
});

describe("session", () => {
	it.effect("assistant appends bump the thread usage aggregates", () =>
		Effect.gen(function* () {
			const threads = yield* Thread.Service;
			const { sessionId, threadId } = yield* createSession();

			yield* threads.append(userEntry(threadId, yield* nextSeq(sessionId), "e1", "hi"));
			yield* threads.append(
				assistantEntry(threadId, yield* nextSeq(sessionId), "e2", {
					usage: usage({ input: 100, output: 20, cacheRead: 40, cacheWrite: 10, costTotal: 0.5 }),
				}),
			);
			yield* threads.append(userEntry(threadId, yield* nextSeq(sessionId), "e3", "again"));
			yield* threads.append(
				assistantEntry(threadId, yield* nextSeq(sessionId), "e4", {
					usage: usage({ input: 150, output: 30, cacheRead: 90, cacheWrite: 0, costTotal: 0.25 }),
				}),
			);

			const row = Option.getOrThrow(yield* threads.get(threadId));
			expect(row.tokensInput).toBe(250);
			expect(row.tokensOutput).toBe(50);
			expect(row.tokensCacheRead).toBe(130);
			expect(row.tokensCacheWrite).toBe(10);
			expect(row.cost).toBeCloseTo(0.75);
			expect((yield* threads.line(threadId)).map((h) => h.entry.id)).toEqual(["e1", "e2", "e3", "e4"]);
		}),
	);

	it.effect("append rejects an unknown thread, a seq that does not advance, and a mismatched envelope", () =>
		Effect.gen(function* () {
			const threads = yield* Thread.Service;
			const { sessionId, threadId } = yield* createSession();
			const seq = yield* nextSeq(sessionId);
			yield* threads.append(userEntry(threadId, seq, "e1", "first"));

			const unknown = yield* threads
				.append(userEntry(ThreadSchema.ID.make("thr_missing"), seq + 1, "e2", "nowhere"))
				.pipe(Effect.flip);
			expect(unknown._tag).toBe("ThreadNotFoundError");

			const stale = yield* threads.append(userEntry(threadId, seq, "e3", "same seq")).pipe(Effect.flip);
			expect(stale._tag).toBe("InvalidEntryDataError");

			const mismatched = yield* threads
				.append({ ...userEntry(threadId, yield* nextSeq(sessionId), "e4", "x"), id: "e4-other" })
				.pipe(Effect.flip);
			expect(mismatched._tag).toBe("InvalidEntryDataError");

			const draftUser = yield* threads
				.append({ ...userEntry(threadId, yield* nextSeq(sessionId), "e5", "x"), state: "draft" })
				.pipe(Effect.flip);
			expect(draftUser._tag).toBe("InvalidEntryDataError");

			expect((yield* threads.line(threadId)).map((h) => h.entry.id)).toEqual(["e1"]);
		}),
	);

	it.effect("duplicate call ids within an entry are rejected by the schema", () =>
		Effect.gen(function* () {
			const threads = yield* Thread.Service;
			const { sessionId, threadId } = yield* createSession();

			const toolPart = (callId: string): Thread.AppendPart => ({
				type: "toolCall",
				status: "pending",
				callId,
				toolName: "read",
				data: JSON.stringify({ type: "toolCall", callID: callId, name: "read", status: "pending" }),
			});

			const exit = yield* threads
				.append({
					...assistantEntry(threadId, yield* nextSeq(sessionId), "e1"),
					state: "draft",
					parts: [toolPart("call_dup"), toolPart("call_dup")],
				})
				.pipe(Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);

			// the failed transaction rolled back whole — no partial entry
			expect(Option.isNone(yield* threads.entry("e1"))).toBe(true);
		}),
	);

	it.effect("append validates compaction shape and boundary against the thread's line", () =>
		Effect.gen(function* () {
			const threads = yield* Thread.Service;
			const source = yield* createSession("/source");
			const other = yield* createSession("/other");
			yield* threads.append(userEntry(source.threadId, yield* nextSeq(source.sessionId), "e1", "root"));
			yield* threads.append(assistantEntry(source.threadId, yield* nextSeq(source.sessionId), "e2"));
			yield* threads.append(userEntry(other.threadId, yield* nextSeq(other.sessionId), "other-e1", "foreign"));

			const compaction = (id: string, data: object) =>
				Effect.map(nextSeq(source.sessionId), (seq): Thread.AppendEntry => ({
					id,
					threadId: source.threadId,
					seq,
					type: "compaction",
					data: JSON.stringify(data),
				}));
			const invalid = [
				yield* compaction("c-missing-boundary", { summary: "missing", tokensBefore: 10 }),
				yield* compaction("c-negative-tokens", { summary: "negative", firstKeptEntryId: null, tokensBefore: -1 }),
				yield* compaction("c-foreign-boundary", {
					summary: "foreign",
					firstKeptEntryId: "other-e1",
					tokensBefore: 10,
				}),
			];
			for (const input of invalid) {
				const error = yield* threads.append(input).pipe(Effect.flip);
				expect(error._tag).toBe("InvalidEntryDataError");
				expect(Option.isNone(yield* threads.entry(input.id))).toBe(true);
			}
			expect(yield* threads.line(source.threadId)).toHaveLength(2);

			const anchored = yield* threads.append(
				yield* compaction("c-anchored", { summary: "root work", firstKeptEntryId: "e1", tokensBefore: 10 }),
			);
			expect(JSON.parse(anchored.data).firstKeptEntryId).toBe("e1");

			const summaryOnly = yield* threads.append(
				yield* compaction("c-summary-only", {
					summary: "all prior work",
					firstKeptEntryId: null,
					tokensBefore: 10,
				}),
			);
			expect(JSON.parse(summaryOnly.data).firstKeptEntryId).toBeNull();
		}),
	);

	it.effect("labels an entry, clears it, and rejects an entry of another thread", () =>
		Effect.gen(function* () {
			const threads = yield* Thread.Service;
			const { sessionId, threadId } = yield* createSession("/labels");
			const other = yield* createSession("/elsewhere");
			yield* threads.append(userEntry(threadId, yield* nextSeq(sessionId), "e1", "mark me"));

			yield* threads.setLabel({ threadId, entryId: "e1", label: "start" });
			const labelled = Option.getOrThrow(yield* threads.entry("e1"));
			expect(Option.getOrUndefined(labelled.entry.label)).toBe("start");

			yield* threads.setLabel({ threadId, entryId: "e1", label: null });
			const cleared = Option.getOrThrow(yield* threads.entry("e1"));
			expect(Option.isNone(cleared.entry.label)).toBe(true);

			const missing = yield* threads
				.setLabel({ threadId: other.threadId, entryId: "e1", label: "x" })
				.pipe(Effect.flip);
			expect(missing._tag).toBe("EntryNotFoundError");
		}),
	);

	it.effect("links a session to a host directory and clears it", () =>
		Effect.gen(function* () {
			const sessions = yield* Session.Service;
			const { sessionId } = yield* createSession();

			const linked = yield* sessions.link({ sessionId, hostDir: AbsolutePath.make("/host/app") });
			expect(Option.getOrUndefined(linked.hostDir)).toBe("/host/app");

			const cleared = yield* sessions.link({ sessionId, hostDir: null });
			expect(Option.isNone(cleared.hostDir)).toBe(true);

			const unknown = yield* sessions
				.link({ sessionId: SessionSchema.ID.make("ses_missing"), hostDir: null })
				.pipe(Effect.flip);
			expect(unknown._tag).toBe("SessionNotFoundError");
		}),
	);

	it.effect("delete removes the session with its threads, entries and log", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const sessions = yield* Session.Service;
			const threads = yield* Thread.Service;
			const events = yield* Event.Service;
			const { sessionId, threadId } = yield* createSession("/doomed");
			const kept = yield* createSession("/kept");
			yield* threads.append(userEntry(threadId, yield* nextSeq(sessionId), "e1", "bye"));

			expect(yield* sessions.delete(sessionId)).toBe(true);

			const [left] = yield* sql<Record<string, number>>`
				SELECT
					(SELECT count(*) FROM session WHERE id = ${sessionId}) AS session,
					(SELECT count(*) FROM thread WHERE session_id = ${sessionId}) AS thread,
					(SELECT count(*) FROM entry WHERE session_id = ${sessionId}) AS entry,
					(SELECT count(*) FROM document WHERE session_id = ${sessionId}) AS document,
					(SELECT count(*) FROM event WHERE aggregate_id = ${sessionId}) AS event,
					(SELECT count(*) FROM sequence WHERE aggregate_id = ${sessionId}) AS sequence
			`;
			expect(left).toEqual({ session: 0, thread: 0, entry: 0, document: 0, event: 0, sequence: 0 });
			expect(yield* events.latestSequence(sessionId)).toBe(0);
			expect(Option.isSome(yield* sessions.get(kept.sessionId))).toBe(true);
			expect(yield* sessions.delete(sessionId)).toBe(false);
		}),
	);

	describe("relink", () => {
		// Two spaces of one project: the env move relinks between them.
		const seedPair = Effect.fnUntraced(function* () {
			const from = yield* seedSpace({ location: "/old/app", projectId: "p", kind: "primary" });
			const to = yield* seedSpace({ location: "/new/app", projectId: "p", kind: "copy" });
			return { from, to };
		});

		it.effect("keeps the session's position under the new root", () =>
			Effect.gen(function* () {
				const { from, to } = yield* seedPair();
				const sessions = yield* Session.Service;
				const { session: created } = yield* sessions.create({
					spaceId: from.spaceId,
					directory: AbsolutePath.make("/old/app/packages/x"),
				});

				const moved = yield* sessions.relink({ sessionId: created.id, spaceId: to.spaceId });
				expect(moved.spaceId).toBe(to.spaceId);
				expect(moved.directory).toBe("/new/app/packages/x");

				// Sitting at the old root lands on the new root.
				const { session: atRoot } = yield* sessions.create({ spaceId: from.spaceId, directory: from.location });
				const movedRoot = yield* sessions.relink({ sessionId: atRoot.id, spaceId: to.spaceId });
				expect(movedRoot.directory).toBe("/new/app");
			}),
		);

		it.effect("an explicit directory under the target wins; outside it is rejected", () =>
			Effect.gen(function* () {
				const { from, to } = yield* seedPair();
				const sessions = yield* Session.Service;
				const { session: created } = yield* sessions.create({
					spaceId: from.spaceId,
					directory: AbsolutePath.make("/old/app/pkg"),
				});

				const explicit = yield* sessions.relink({
					sessionId: created.id,
					spaceId: to.spaceId,
					directory: AbsolutePath.make("/new/app/other"),
				});
				expect(explicit.directory).toBe("/new/app/other");

				const rejected = yield* sessions
					.relink({ sessionId: created.id, spaceId: to.spaceId, directory: AbsolutePath.make("/nope") })
					.pipe(Effect.flip);
				expect(rejected).toMatchObject({ _tag: "RelinkError", reason: "directory_outside_space" });
			}),
		);

		it.effect("rejects a space of another project without touching the session", () =>
			Effect.gen(function* () {
				const { from } = yield* seedPair();
				const other = yield* seedSpace({ location: "/other", projectId: "q", kind: "primary" });
				const sessions = yield* Session.Service;
				const { session: created } = yield* sessions.create({ spaceId: from.spaceId, directory: from.location });

				const error = yield* sessions.relink({ sessionId: created.id, spaceId: other.spaceId }).pipe(Effect.flip);
				expect(error).toMatchObject({ _tag: "RelinkError", reason: "project_scope_mismatch" });
				const row = Option.getOrThrow(yield* sessions.get(created.id));
				expect(row.spaceId).toBe(from.spaceId);
			}),
		);

		it.effect("with a thread, places that thread and leaves the session where it was", () =>
			Effect.gen(function* () {
				const { from, to } = yield* seedPair();
				const sessions = yield* Session.Service;
				const documents = yield* Document.Service;
				const { session: created, thread } = yield* sessions.create({
					spaceId: from.spaceId,
					directory: AbsolutePath.make("/old/app/packages/x"),
				});
				const threadId = ThreadSchema.ID.make(thread.id);

				const row = yield* sessions.relink({ sessionId: created.id, threadId, spaceId: to.spaceId });
				expect(row.spaceId).toBe(from.spaceId);
				expect(row.directory).toBe("/old/app/packages/x");
				expect((yield* documents.agent(threadId)).placement).toEqual({
					spaceId: to.spaceId,
					directory: "/new/app/packages/x",
				});
				const placed = Option.getOrThrow(yield* sessions.placement(threadId));
				expect(placed.space.id).toBe(to.spaceId);
				expect(placed.directory).toBe("/new/app/packages/x");

				// A thread of another session is not this session's to place.
				const { thread: foreign } = yield* sessions.create({ spaceId: from.spaceId, directory: from.location });
				const error = yield* sessions
					.relink({ sessionId: created.id, threadId: ThreadSchema.ID.make(foreign.id), spaceId: to.spaceId })
					.pipe(Effect.flip);
				expect(error._tag).toBe("ThreadNotFoundError");
			}),
		);
	});
});
