import { Message } from "@codeworksh/aikit";
import { DateTime, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { ContextCodec } from "../src/context/codec.ts";
import { Event } from "../src/event/event.ts";
import { EventList } from "../src/event/list.ts";
import { SessionInput } from "../src/session/input/input.ts";
import { SessionMessageSchema } from "../src/session/message/schema.ts";
import { SessionProjector } from "../src/session/projector.ts";
import { PromptSchema } from "../src/session/prompt/schema.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { Session } from "../src/session/session.ts";
import { testEffect } from "./utils/effect.ts";

// `Option` has no `.value` on the union — these tests treat a missing row as a
// bug in the code under test, not a case to handle.
const some = <A>(option: Option.Option<A>): A => Option.getOrThrow(option);

const base = Session.layer.pipe(Layer.provideMerge(Event.layer), Layer.provideMerge(Database.layer(":memory:")));
// Provided twice on purpose: a layer is built once per graph, so the projectors
// register once. Registering them per consumer instead would make every
// admission conflict with itself.
const wired = Layer.provideMerge(Layer.merge(SessionProjector.layer, SessionProjector.layer), base);

const { effect: it } = testEffect(wired);
const { effect: itUnwired } = testEffect(base);

const sessionId = SessionSchema.ID.make("ses_a");
const other = SessionSchema.ID.make("ses_b");
const prompt = PromptSchema.Prompt.make({ text: "fix the bug" });

const seedSessions = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`INSERT OR IGNORE INTO project (id, name, created_at, updated_at) VALUES ('local','local',0,0)`;
	for (const id of [sessionId, other]) {
		yield* sql`
			INSERT INTO session (id, project_id, slug, directory, title, tag, sandbox_instance_id, created_at, updated_at)
			VALUES (${id}, 'local', ${id}, '/repo', 'T', 'test', NULL, 0, 0)
		`;
	}
});

const admit = (
	input: SessionInput.Interface,
	text: string,
	delivery: PromptSchema.Delivery = "steer",
	target: SessionSchema.ID = sessionId,
) =>
	input.admit({
		id: SessionMessageSchema.ID.create(),
		sessionId: target,
		prompt: PromptSchema.Prompt.make({ text }),
		delivery,
	});

const setup = Effect.gen(function* () {
	yield* seedSessions;
	return yield* SessionInput.make;
});

describe("SessionInput admission", () => {
	it("records a prompt durably and returns its admitted position", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const input = yield* setup;
			const admitted = yield* input.admit({
				id: SessionMessageSchema.ID.create(),
				sessionId,
				prompt,
				delivery: "steer",
			});

			expect(admitted.admittedSeq).toBe(0);
			expect(admitted.promotedSeq).toBeUndefined();
			// The column holds JSON; the row model owns the boundary.
			const rows = yield* sql`SELECT * FROM session_input`;
			expect(JSON.parse(rows[0]!.prompt as string)).toEqual({ text: "fix the bug" });
			expect((yield* sql`SELECT id FROM session_input WHERE promoted_seq IS NULL`).length).toBe(1);

			const found = yield* input.find(admitted.id);
			expect(some(found).prompt).toEqual({ text: "fix the bug" });
			expect(SessionInput.equivalent(some(found), { sessionId, prompt, delivery: "steer" })).toBe(true);
		}));

	// A client that retries a timed-out prompt sends the same id. That has to be
	// a no-op, not a second turn.
	it("is idempotent for a repeated id — no second event, no second row", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const input = yield* setup;
			const id = SessionMessageSchema.ID.create();

			const first = yield* input.admit({ id, sessionId, prompt, delivery: "steer" });
			const again = yield* input.admit({ id, sessionId, prompt, delivery: "steer" });

			expect(again.admittedSeq).toBe(first.admittedSeq);
			expect((yield* sql`SELECT * FROM session_input`).length).toBe(1);
			expect((yield* sql`SELECT * FROM event`).length).toBe(1);
		}));

	// The stored row wins, and the caller is expected to compare. `equivalent`
	// is what turns "same id, different prompt" into a conflict upstream.
	it("returns the stored row when a reused id carries a different prompt", () =>
		Effect.gen(function* () {
			const input = yield* setup;
			const id = SessionMessageSchema.ID.create();
			yield* input.admit({ id, sessionId, prompt, delivery: "steer" });

			const changed = PromptSchema.Prompt.make({ text: "something else" });
			const second = yield* input.admit({ id, sessionId, prompt: changed, delivery: "steer" });

			expect(second.prompt).toEqual({ text: "fix the bug" });
			expect(SessionInput.equivalent(second, { sessionId, prompt: changed, delivery: "steer" })).toBe(false);
			expect(SessionInput.equivalent(second, { sessionId, prompt, delivery: "steer" })).toBe(true);
			// A different lane is a conflict too, not just different text.
			expect(SessionInput.equivalent(second, { sessionId, prompt, delivery: "followUp" })).toBe(false);
		}));

	// An id that already became an entry has left the inbox for good.
	it("refuses an id that already graduated into session_entry", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const input = yield* setup;
			const id = SessionMessageSchema.ID.create();
			yield* sql`
				INSERT INTO session_entry (id, session_id, parent_id, seq, type, data, created_at, updated_at)
				VALUES (${id}, ${sessionId}, NULL, 0, 'user', '{}', 0, 0)
			`;

			const exit = yield* input.admit({ id, sessionId, prompt, delivery: "steer" }).pipe(Effect.exit);

			expect(exit._tag).toBe("Failure");
			// The projector rejected it inside the commit, so no event survives.
			expect((yield* sql`SELECT * FROM event`).length).toBe(0);
			expect((yield* sql`SELECT * FROM session_input`).length).toBe(0);
		}));

	// Without the projector layer nothing errors — the event lands and the inbox
	// stays empty. Silent, and the reason this assertion exists.
	itUnwired("writes no row when the projector layer is missing from the graph", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* seedSessions;
			const input = yield* SessionInput.make;

			yield* input.admit({ id: SessionMessageSchema.ID.create(), sessionId, prompt, delivery: "steer" });

			expect((yield* sql`SELECT * FROM event`).length).toBe(1);
			expect((yield* sql`SELECT * FROM session_input`).length).toBe(0);
		}),
	);
});

describe("SessionInput promotion", () => {
	it("tracks pending work per lane", () =>
		Effect.gen(function* () {
			const input = yield* setup;
			expect(yield* input.hasPending(sessionId, "steer")).toBe(false);
			expect(yield* input.hasPending(sessionId, "followUp")).toBe(false);

			yield* admit(input, "steer one", "steer");
			expect(yield* input.hasPending(sessionId, "steer")).toBe(true);
			expect(yield* input.hasPending(sessionId, "followUp")).toBe(false);

			yield* admit(input, "later", "followUp");
			expect(yield* input.hasPending(sessionId, "followUp")).toBe(true);
			// Another session's inbox is not this one's.
			expect(yield* input.hasPending(other, "steer")).toBe(false);
		}));

	it("stamps promoted_seq with the promoting event's own sequence", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const input = yield* setup;
			const events = yield* Event.Service;
			const admitted = yield* admit(input, "one");

			yield* input.promoteSteers(sessionId, yield* events.latestSequence(sessionId));

			const promoted = some(yield* input.find(admitted.id));
			const prompted = yield* sql`SELECT * FROM event WHERE type = 'session.next.prompt.promoted.1'`;
			expect(prompted.length).toBe(1);
			expect(promoted.promotedSeq).toBe(prompted[0]!.seq);
			// Delivery order lives in the same space as everything else durable.
			expect(promoted.promotedSeq).toBeGreaterThan(promoted.admittedSeq);
		}));

	// The cutoff is captured before promotion so a steer arriving mid-flight
	// cannot join a request that is already being assembled.
	it("promotes steers only up to the captured cutoff", () =>
		Effect.gen(function* () {
			const input = yield* setup;
			const events = yield* Event.Service;
			const first = yield* admit(input, "one");
			const second = yield* admit(input, "two");
			const cutoff = yield* events.latestSequence(sessionId);
			const late = yield* admit(input, "three");

			expect(yield* input.promoteSteers(sessionId, cutoff)).toBe(2);

			expect(some(yield* input.find(first.id)).promotedSeq).toBeDefined();
			expect(some(yield* input.find(second.id)).promotedSeq).toBeDefined();
			expect(some(yield* input.find(late.id)).promotedSeq).toBeUndefined();
			expect(yield* input.hasPending(sessionId, "steer")).toBe(true);
		}));

	it("promotes steers in admission order", () =>
		Effect.gen(function* () {
			const input = yield* setup;
			const events = yield* Event.Service;
			const first = yield* admit(input, "one");
			const second = yield* admit(input, "two");

			yield* input.promoteSteers(sessionId, yield* events.latestSequence(sessionId));

			const a = some(yield* input.find(first.id));
			const b = some(yield* input.find(second.id));
			expect(b.promotedSeq!).toBeGreaterThan(a.promotedSeq!);
		}));

	// One per run, unlike steers — that is what makes the lane turn-at-a-time.
	it("promotes exactly one follow-up at a time, oldest first", () =>
		Effect.gen(function* () {
			const input = yield* setup;
			const first = yield* admit(input, "one", "followUp");
			const second = yield* admit(input, "two", "followUp");

			expect(yield* input.promoteFollowUp(sessionId)).toBe(true);
			expect(some(yield* input.find(first.id)).promotedSeq).toBeDefined();
			expect(some(yield* input.find(second.id)).promotedSeq).toBeUndefined();

			expect(yield* input.promoteFollowUp(sessionId)).toBe(true);
			expect(yield* input.hasPending(sessionId, "followUp")).toBe(false);
			expect(yield* input.promoteFollowUp(sessionId)).toBe(false);
		}));

	it("does not re-deliver or renumber on a second drain", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const input = yield* setup;
			const events = yield* Event.Service;
			const admitted = yield* admit(input, "one");
			yield* input.promoteSteers(sessionId, yield* events.latestSequence(sessionId));
			const promotedSeq = some(yield* input.find(admitted.id)).promotedSeq;

			expect(yield* input.promoteSteers(sessionId, yield* events.latestSequence(sessionId))).toBe(0);

			expect(some(yield* input.find(admitted.id)).promotedSeq).toBe(promotedSeq);
			expect((yield* sql`SELECT * FROM event WHERE type = 'session.next.prompt.promoted.1'`).length).toBe(1);
		}));

	it("keeps lanes and sessions apart when promoting", () =>
		Effect.gen(function* () {
			const input = yield* setup;
			const events = yield* Event.Service;
			const steer = yield* admit(input, "steer", "steer");
			const followUp = yield* admit(input, "later", "followUp");
			const elsewhere = yield* admit(input, "other session", "steer", other);

			yield* input.promoteSteers(sessionId, yield* events.latestSequence(sessionId));

			expect(some(yield* input.find(steer.id)).promotedSeq).toBeDefined();
			expect(some(yield* input.find(followUp.id)).promotedSeq).toBeUndefined();
			expect(some(yield* input.find(elsewhere.id)).promotedSeq).toBeUndefined();
		}));
});

describe("SessionInput projections", () => {
	// Registering per consumer instead of once in the layer would produce exactly
	// this: the second insert conflicts and takes the whole admission down.
	it("a duplicate projector registration breaks admission entirely", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const input = yield* setup;
			const events = yield* Event.Service;

			yield* events.project(EventList.PromptAdmitted, (event) =>
				input.projectAdmitted({
					admittedSeq: event.durable!.seq,
					id: event.data.messageId,
					sessionId: event.data.sessionId,
					prompt: event.data.prompt,
					delivery: event.data.delivery,
					timeCreated: event.data.timestamp,
				}),
			);

			const exit = yield* admit(input, "one").pipe(Effect.exit);
			expect(exit._tag).toBe("Failure");
			expect((yield* sql`SELECT * FROM session_input`).length).toBe(0);
			expect((yield* sql`SELECT * FROM event`).length).toBe(0);
		}));

	// Both projections have to go together. An input and the entry it became are
	// one identity, and `projectAdmitted` refuses an id that already graduated —
	// so wiping the inbox alone leaves the entry behind to reject the replay.
	// The projection is where publish-time context survives, because the log
	// itself never carried it.
	it("carries the promoting event's metadata onto the entry", () =>
		Effect.gen(function* () {
			const input = yield* setup;
			const events = yield* Event.Service;
			const sessions = yield* Session.Service;
			const admitted = yield* admit(input, "one");

			yield* events.publish(
				EventList.Prompted,
				{
					sessionId,
					timestamp: admitted.timeCreated,
					messageId: admitted.id,
					prompt: admitted.prompt,
					delivery: admitted.delivery,
				},
				{ metadata: { requestId: "req_7" } },
			);

			const path = yield* sessions.path(sessionId);
			expect(path.map((h) => h.entry.id)).toEqual([admitted.id]);
			expect(some(path[0]!.entry.metadata)).toEqual({ requestId: "req_7" });
		}));

	it("leaves entry metadata unset when the event carried none", () =>
		Effect.gen(function* () {
			const input = yield* setup;
			const events = yield* Event.Service;
			const sessions = yield* Session.Service;
			yield* admit(input, "one");
			yield* input.promoteSteers(sessionId, yield* events.latestSequence(sessionId));

			const path = yield* sessions.path(sessionId);
			expect(Option.isNone(path[0]!.entry.metadata)).toBe(true);
		}));

	it("rebuilds both projections from the log alone", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const input = yield* setup;
			const events = yield* Event.Service;
			const sessions = yield* Session.Service;
			const admitted = yield* admit(input, "one");
			yield* input.promoteSteers(sessionId, yield* events.latestSequence(sessionId));
			const before = some(yield* input.find(admitted.id));
			const beforePath = yield* sessions.path(sessionId);

			const stored = yield* sql`SELECT * FROM event ORDER BY seq`;
			// session_entry parents itself, so a bulk delete trips the edge before
			// the children are gone. Only the wipe needs the constraint relaxed —
			// the rebuild below runs with it back on.
			yield* sql`PRAGMA foreign_keys = OFF`;
			yield* sql`UPDATE session SET leaf_entry_id = NULL WHERE id = ${sessionId}`;
			yield* sql`DELETE FROM session_entry_part`;
			yield* sql`DELETE FROM session_entry`;
			yield* sql`DELETE FROM session_input`;
			yield* sql`PRAGMA foreign_keys = ON`;
			expect(Option.isNone(yield* input.find(admitted.id))).toBe(true);
			expect(yield* sessions.path(sessionId)).toEqual([]);

			// Replaying the log through the same mapping the projector uses.
			for (const row of stored) {
				const data = JSON.parse(row.data as string);
				const shared = {
					id: SessionMessageSchema.ID.make(data.messageId),
					sessionId: SessionSchema.ID.make(data.sessionId),
					prompt: PromptSchema.Prompt.make(data.prompt),
					delivery: data.delivery,
					timeCreated: before.timeCreated,
				};
				const seq = row.seq as number;
				if (row.type === "session.next.prompt.admitted.1") {
					yield* input.projectAdmitted({ ...shared, admittedSeq: seq });
					continue;
				}
				yield* input.projectPrompted({ ...shared, promotedSeq: seq });
				const encoded = yield* ContextCodec.encodeMessage(
					Message.createUserMessage({
						messageId: shared.id,
						role: "user",
						time: { created: DateTime.toEpochMillis(shared.timeCreated) },
						parts: [{ type: "text", text: shared.prompt.text }],
					}),
				);
				yield* sessions.append({ id: shared.id, sessionId: shared.sessionId, seq, ...encoded });
			}

			const after = some(yield* input.find(admitted.id));
			expect(after.admittedSeq).toBe(before.admittedSeq);
			expect(after.promotedSeq).toBe(before.promotedSeq);
			expect(after.prompt).toEqual(before.prompt);

			const afterPath = yield* sessions.path(sessionId);
			expect(afterPath.map((h) => [h.entry.id, h.entry.seq])).toEqual(
				beforePath.map((h) => [h.entry.id, h.entry.seq]),
			);
		}));
});
