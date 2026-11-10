import { Cause, DateTime, Effect, Exit, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";
import { Control } from "../src/control.ts";
import { ContextCodec } from "../src/context/codec.ts";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { EventList } from "../src/event/list.ts";
import { Inbox } from "../src/inbox/inbox.ts";
import { Mcp } from "../src/mcp/mcp.ts";
import { RunnerExecution } from "../src/runner/execution.ts";
import { Process } from "../src/sandbox/utils/process.ts";
import { SessionLive } from "../src/session/live.ts";
import { SessionMessageSchema } from "../src/session/message/schema.ts";
import { PromptSchema } from "../src/session/prompt/schema.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { Session } from "../src/session/session.ts";
import { ThreadSchema } from "../src/thread/schema.ts";
import { Thread } from "../src/thread/thread.ts";
import { seedSpace } from "./fixtures/space.ts";
import { testEffect } from "./utils/effect.ts";

// `Option` has no `.value` on the union — these tests treat a missing row as a
// bug in the code under test, not a case to handle.
const some = <A>(option: Option.Option<A>): A => Option.getOrThrow(option);

const layer = Control.layer.pipe(
	// Admission is the whole subject here, so there is nothing to drain and the
	// wake has nowhere to go.
	Layer.provide(RunnerExecution.noopLayer),
	Layer.provide(Mcp.layer({ hostCwd: "/", home: "/unused/home" }).pipe(Layer.provide(Process.host))),
	Layer.provideMerge(SessionLive.layer),
	Layer.provideMerge(Event.layer),
	Layer.provideMerge(Database.layer(":memory:")),
);
const { effect: it } = testEffect(layer);

const messageId = SessionMessageSchema.ID.make("msg_fixed");
const text = "Fix the failing tests";

const setup = Effect.gen(function* () {
	const { spaceId, location } = yield* seedSpace();
	const sessions = yield* Session.Service;
	const { session, thread } = yield* sessions.create({ spaceId, directory: location, title: "T", tag: "test" });
	return {
		sessions,
		threads: yield* Thread.Service,
		control: yield* Control.Service,
		sessionId: SessionSchema.ID.make(session.id),
		threadId: ThreadSchema.ID.make(thread.id),
	};
});

const admittedCount = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	return (yield* sql`SELECT id FROM inbox`).length;
});

const eventCount = (type: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		return (yield* sql`SELECT id FROM event WHERE type = ${type}`).length;
	});

const prompt = (text: string) => PromptSchema.Prompt.fromText(text);

describe("Control.prompt", () => {
	it("returns the original record when the id is retried", () =>
		Effect.gen(function* () {
			const { threads, control, sessionId, threadId } = yield* setup;
			const input = { sessionId, id: messageId, prompt: prompt(text) };

			const first = yield* control.prompt(input);
			const retried = yield* control.prompt(input);

			expect(retried).toEqual(first);
			expect(yield* admittedCount).toBe(1);
			expect(yield* threads.line(threadId)).toEqual([]);
		}));

	it("rejects reuse of one id with a different prompt", () =>
		Effect.gen(function* () {
			const { control, sessionId } = yield* setup;
			yield* control.prompt({ sessionId, id: messageId, prompt: prompt(text) });

			const failure = yield* control
				.prompt({ sessionId, id: messageId, prompt: prompt("Delete the failing tests") })
				.pipe(Effect.flip);

			expect(failure._tag).toBe("PromptConflictError");
			// The stored row survives untouched; the conflict changed nothing.
			expect(yield* admittedCount).toBe(1);
		}));

	it("returns one record to concurrent exact retries", () =>
		Effect.gen(function* () {
			const { control, sessionId } = yield* setup;
			const input = { sessionId, id: messageId, prompt: prompt(text) };

			const both = yield* Effect.all([control.prompt(input), control.prompt(input)], {
				concurrency: "unbounded",
			});

			expect(both[1]).toEqual(both[0]);
			expect(yield* admittedCount).toBe(1);
			// The loser's event rolled back with its projector, so only one exists.
			expect(yield* eventCount("session.prompt.admitted.1")).toBe(1);
		}));

	it("promotes once under concurrent promotion attempts", () =>
		Effect.gen(function* () {
			const { threads, control, sessionId, threadId } = yield* setup;
			const inputs = yield* Inbox.make;
			const admitted = yield* control.prompt({ sessionId, id: messageId, prompt: prompt("Promote once") });

			const counts = yield* Effect.all(
				[
					inputs.promote(threadId, Number.MAX_SAFE_INTEGER, "postTools"),
					inputs.promote(threadId, Number.MAX_SAFE_INTEGER, "postTools"),
				],
				{ concurrency: "unbounded" },
			);

			// Exactly one caller won it. A count is "work this caller promoted", so
			// the loser reporting 1 would have both of them answer the same prompt.
			expect(counts[0] + counts[1]).toBe(1);
			expect(yield* eventCount("session.prompt.promoted.1")).toBe(1);
			const promoted = some(yield* inputs.find(admitted.id));
			expect(promoted.promotedSeq).toBeDefined();

			// Promotion is what puts the prompt in the conversation, and the entry
			// carries the promoting event's position.
			const line = yield* threads.line(threadId);
			expect(line.map((h) => h.entry.id)).toEqual([messageId]);
			expect(line[0]!.entry.seq).toBe(promoted.promotedSeq);
			expect(ContextCodec.parts(yield* ContextCodec.decodeMessage(line[0]!))[0]).toMatchObject({
				type: "text",
				text: "Promote once",
			});
		}));

	it("reports the follow-up to whichever caller won it", () =>
		Effect.gen(function* () {
			const { control, sessionId, threadId } = yield* setup;
			const inputs = yield* Inbox.make;
			yield* control.prompt({ sessionId, prompt: prompt("Later"), delivery: "followUp" });

			const won = yield* Effect.all(
				[
					inputs.promote(threadId, Number.MAX_SAFE_INTEGER, "final"),
					inputs.promote(threadId, Number.MAX_SAFE_INTEGER, "final"),
				],
				{
					concurrency: "unbounded",
				},
			);

			expect(won.filter(Boolean).length).toBe(1);
			expect(yield* eventCount("session.prompt.promoted.1")).toBe(1);
			expect(yield* inputs.hasPending(threadId, "followUp")).toBe(false);
		}));

	it("promotes steers only through the captured cutoff", () =>
		Effect.gen(function* () {
			const { threads, control, sessionId, threadId } = yield* setup;
			const inputs = yield* Inbox.make;
			const first = yield* control.prompt({ sessionId, prompt: prompt("Before cutoff") });
			const cutoff = first.admittedSeq;
			const second = yield* control.prompt({ sessionId, prompt: prompt("After cutoff") });

			yield* inputs.promote(threadId, cutoff, "postTools");

			expect(some(yield* inputs.find(first.id)).promotedSeq).toBeDefined();
			expect(some(yield* inputs.find(second.id)).promotedSeq).toBeUndefined();
			expect((yield* threads.line(threadId)).map((h) => h.entry.id)).toEqual([first.id]);
		}));
});

describe("Control threads", () => {
	it("addresses main when no thread is named, and keeps each thread's queue its own", () =>
		Effect.gen(function* () {
			const { threads, control, sessionId, threadId } = yield* setup;
			const inputs = yield* Inbox.make;
			const first = yield* control.prompt({ sessionId, prompt: prompt("On main") });
			expect(first.threadId).toBe(threadId);
			yield* inputs.promote(threadId, Number.MAX_SAFE_INTEGER, "postTools");

			const forked = yield* threads.fork({ threadId, entryId: first.id });
			const fork = ThreadSchema.ID.make(forked.thread.id);
			const onFork = yield* control.prompt({ sessionId, threadId: fork, prompt: prompt("On the fork") });
			const onMain = yield* control.prompt({ sessionId, prompt: prompt("Main again") });

			expect((yield* control.pending(fork)).map((input) => input.id)).toEqual([onFork.id]);
			expect((yield* control.pending(threadId)).map((input) => input.id)).toEqual([onMain.id]);
			expect(yield* control.cancel(threadId, onFork.id)).toBe(false);
			expect(yield* control.update(threadId, onFork.id, { delivery: "followUp" })).toBe(false);
		}));

	it("refuses a thread of another session, and an unknown session", () =>
		Effect.gen(function* () {
			const { sessions, control, sessionId } = yield* setup;
			const { spaceId, location } = yield* seedSpace();
			const { thread: other } = yield* sessions.create({ spaceId, directory: location });

			const foreign = yield* control
				.prompt({ sessionId, threadId: ThreadSchema.ID.make(other.id), prompt: prompt(text) })
				.pipe(Effect.flip);
			expect(foreign._tag).toBe("ThreadNotFoundError");
			const unknown = yield* control
				.prompt({ sessionId: SessionSchema.ID.make("ses_missing"), prompt: prompt(text) })
				.pipe(Effect.flip);
			expect(unknown._tag).toBe("SessionNotFoundError");
			expect(yield* admittedCount).toBe(0);
		}));

	it("deletes a session with its pending prompts; an idle session has nothing to interrupt", () =>
		Effect.gen(function* () {
			const { sessions, control, sessionId } = yield* setup;
			yield* control.prompt({ sessionId, prompt: prompt(text) });

			expect(yield* control.interruptSession(sessionId)).toBe(false);
			expect(yield* control.deleteSession(sessionId)).toBe(true);
			expect(Option.isNone(yield* sessions.get(sessionId))).toBe(true);
			expect(yield* admittedCount).toBe(0);
			expect(yield* control.deleteSession(sessionId)).toBe(false);
		}));
});

describe("Control lifecycle", () => {
	// The publisher read the thread, then the session was deleted before the commit: the event must roll back
	// with its projection, or it recreates the session's sequence row.
	it("rolls back a lifecycle event for a thread deleted since, leaving no sequence row", () =>
		Effect.gen(function* () {
			const { sessions, sessionId, threadId } = yield* setup;
			const events = yield* Event.Service;
			const sql = yield* SqlClient.SqlClient;
			yield* sessions.delete(sessionId);

			const exit = yield* events
				.publish(EventList.ExecutionStarted, {
					timestamp: yield* DateTime.now,
					sessionId,
					threadId,
					resumed: false,
				})
				.pipe(Effect.exit);

			expect(Exit.isFailure(exit) && Schema.is(Thread.ThreadNotFoundError)(Cause.squash(exit.cause))).toBe(true);
			expect(yield* sql`SELECT seq FROM sequence WHERE aggregate_id = ${sessionId}`).toEqual([]);
			expect(yield* sql`SELECT id FROM event WHERE aggregate_id = ${sessionId}`).toEqual([]);
		}));
});

describe("Control.interrupt", () => {
	// No execution here owns the thread (the next start has not resumed it yet), but durable state says its
	// run is owed a resume: the stop must stand, not be dropped.
	it("ends a run the last process cut off when no execution here owns it", () =>
		Effect.gen(function* () {
			const { threads, control, sessionId, threadId } = yield* setup;
			const events = yield* Event.Service;
			yield* events.publish(EventList.ExecutionStarted, {
				timestamp: yield* DateTime.now,
				sessionId,
				threadId,
				resumed: false,
			});
			yield* events.publish(EventList.ExecutionInterrupted, {
				timestamp: yield* DateTime.now,
				sessionId,
				threadId,
				reason: "crash",
			});

			expect(yield* control.interrupt(threadId)).toBe(true);
			expect(yield* threads.resumable(threadId)).toBe(false);
			expect((yield* threads.unfinished).map((row) => row.id)).not.toContain(threadId);
			// Nothing is owed any more: a second stop has nothing to end.
			expect(yield* control.interrupt(threadId)).toBe(false);
		}));
});

describe("Control.cancel", () => {
	it("lists pending prompts of both lanes in admission order, without promoted or cancelled ones", () =>
		Effect.gen(function* () {
			const { control, sessionId, threadId } = yield* setup;
			const inputs = yield* Inbox.make;
			const first = yield* control.prompt({ sessionId, prompt: prompt("First steer") });
			const later = yield* control.prompt({ sessionId, prompt: prompt("Later"), delivery: "followUp" });
			const second = yield* control.prompt({ sessionId, prompt: prompt("Second steer") });
			const dropped = yield* control.prompt({ sessionId, prompt: prompt("Dropped") });

			expect((yield* control.pending(threadId)).map((input) => [input.id, input.delivery])).toEqual([
				[first.id, "steer"],
				[later.id, "followUp"],
				[second.id, "steer"],
				[dropped.id, "steer"],
			]);

			yield* control.cancel(threadId, dropped.id);
			yield* inputs.promote(threadId, Number.MAX_SAFE_INTEGER, "postTools");
			expect((yield* control.pending(threadId)).map((input) => input.id)).toEqual([later.id]);
		}));

	it("cancels a pending prompt once and refuses a second cancel", () =>
		Effect.gen(function* () {
			const { threads, control, sessionId, threadId } = yield* setup;
			const inputs = yield* Inbox.make;
			const admitted = yield* control.prompt({ sessionId, id: messageId, prompt: prompt(text) });

			expect(yield* control.cancel(threadId, admitted.id)).toBe(true);
			expect(yield* control.cancel(threadId, admitted.id)).toBe(false);

			expect(yield* eventCount("session.prompt.cancelled.1")).toBe(1);
			expect(yield* control.pending(threadId)).toEqual([]);
			expect(yield* inputs.hasPending(threadId, "steer")).toBe(false);
			expect(some(yield* inputs.find(admitted.id)).cancelledSeq).toBeDefined();
			// Nothing is left to promote, and nothing reaches the conversation.
			expect(yield* inputs.promote(threadId, Number.MAX_SAFE_INTEGER, "postTools")).toBe(0);
			expect(yield* threads.line(threadId)).toEqual([]);
		}));

	it("refuses to cancel another session's prompt, or an unknown id", () =>
		Effect.gen(function* () {
			const { sessions, control, sessionId, threadId } = yield* setup;
			const { spaceId, location } = yield* seedSpace();
			const { thread: other } = yield* sessions.create({
				spaceId,
				directory: location,
				title: "Other",
				tag: "test",
			});
			const admitted = yield* control.prompt({ sessionId, prompt: prompt(text) });

			expect(yield* control.cancel(ThreadSchema.ID.make(other.id), admitted.id)).toBe(false);
			expect(yield* control.cancel(threadId, SessionMessageSchema.ID.make("msg_unknown"))).toBe(false);

			expect(yield* eventCount("session.prompt.cancelled.1")).toBe(0);
			expect((yield* control.pending(threadId)).map((input) => input.id)).toEqual([admitted.id]);
		}));

	it("refuses to cancel a promoted prompt, which stays in the conversation", () =>
		Effect.gen(function* () {
			const { threads, control, sessionId, threadId } = yield* setup;
			const inputs = yield* Inbox.make;
			const admitted = yield* control.prompt({ sessionId, prompt: prompt(text) });
			yield* inputs.promote(threadId, Number.MAX_SAFE_INTEGER, "postTools");

			expect(yield* control.cancel(threadId, admitted.id)).toBe(false);

			expect(yield* eventCount("session.prompt.cancelled.1")).toBe(0);
			expect((yield* threads.line(threadId)).map((h) => h.entry.id)).toEqual([admitted.id]);
		}));

	it("admits a cancelled id again, as a fresh pending prompt", () =>
		Effect.gen(function* () {
			const { threads, control, sessionId, threadId } = yield* setup;
			const inputs = yield* Inbox.make;
			const first = yield* control.prompt({ sessionId, id: messageId, prompt: prompt(text) });
			yield* control.cancel(threadId, messageId);

			const retried = yield* control.prompt({
				sessionId,
				id: messageId,
				prompt: prompt("Fix it another way"),
				delivery: "followUp",
			});

			expect(retried.cancelledSeq).toBeUndefined();
			expect(retried.admittedSeq).toBeGreaterThan(first.admittedSeq);
			expect(yield* control.pending(threadId)).toMatchObject([{ id: messageId, delivery: "followUp" }]);
			expect(
				yield* control.prompt({
					sessionId,
					id: messageId,
					prompt: prompt("Fix it another way"),
					delivery: "followUp",
				}),
			).toEqual(retried);

			expect(yield* inputs.promote(threadId, Number.MAX_SAFE_INTEGER, "final")).toBe(1);
			const line = yield* threads.line(threadId);
			expect(line.map((h) => h.entry.id)).toEqual([messageId]);
			expect(ContextCodec.parts(yield* ContextCodec.decodeMessage(line[0]!))[0]).toMatchObject({
				text: "Fix it another way",
			});
		}));

	// The promotion the runner had already read for a row that is then cancelled: it must lose,
	// not read the cancelled row as a replay onto an empty projection and append it anyway.
	it("rolls back a promotion that commits after the cancel", () =>
		Effect.gen(function* () {
			const { threads, control, sessionId, threadId } = yield* setup;
			const events = yield* Event.Service;
			const admitted = yield* control.prompt({ sessionId, prompt: prompt(text) });
			yield* control.cancel(threadId, admitted.id);

			const late = yield* events
				.publish(EventList.Prompted, {
					sessionId,
					threadId,
					timestamp: admitted.timeCreated,
					messageId: admitted.id,
					prompt: admitted.prompt,
					delivery: admitted.delivery,
				})
				.pipe(Effect.exit);

			expect(Exit.isFailure(late)).toBe(true);
			expect(yield* eventCount("session.prompt.promoted.1")).toBe(0);
			expect(yield* threads.line(threadId)).toEqual([]);
		}));

	it("lets exactly one of a cancel and a promotion win the same prompt", () =>
		Effect.gen(function* () {
			const { threads, control, sessionId, threadId } = yield* setup;
			const inputs = yield* Inbox.make;
			const admitted = yield* control.prompt({ sessionId, prompt: prompt(text) });

			const [cancelled, promoted] = yield* Effect.all(
				[control.cancel(threadId, admitted.id), inputs.promote(threadId, Number.MAX_SAFE_INTEGER, "postTools")],
				{ concurrency: "unbounded" },
			);

			expect(cancelled !== (promoted === 1)).toBe(true);
			expect((yield* threads.line(threadId)).map((h) => h.entry.id)).toEqual(cancelled ? [] : [admitted.id]);
			expect(yield* eventCount("session.prompt.cancelled.1")).toBe(cancelled ? 1 : 0);
			expect(yield* eventCount("session.prompt.promoted.1")).toBe(cancelled ? 0 : 1);
		}));

	it("does not turn an unrelated projector defect into a lost cancel", () =>
		Effect.gen(function* () {
			const { control, sessionId, threadId } = yield* setup;
			const events = yield* Event.Service;
			const admitted = yield* control.prompt({ sessionId, prompt: prompt(text) });
			const defect = new Error("projector failed");
			yield* events.project(EventList.PromptCancelled, () => Effect.die(defect));

			const exit = yield* control.cancel(threadId, admitted.id).pipe(Effect.exit);

			expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(defect);
			expect(yield* eventCount("session.prompt.cancelled.1")).toBe(0);
			expect((yield* control.pending(threadId)).map((input) => input.id)).toEqual([admitted.id]);
		}));
});

// Records wakes, so a test can tell which updates ask the runner to look again.
const wakes: string[] = [];
const watched = Control.layer.pipe(
	Layer.provide(
		Layer.succeed(
			RunnerExecution.Service,
			RunnerExecution.Service.of({
				active: Effect.succeed(new Set()),
				resume: () => Effect.void,
				wake: (threadId) => Effect.sync(() => wakes.push(threadId)),
				interrupt: () => Effect.succeed(false),
				awaitIdle: () => Effect.void,
			}),
		),
	),
	Layer.provide(Mcp.layer({ hostCwd: "/", home: "/unused/home" }).pipe(Layer.provide(Process.host))),
	Layer.provideMerge(SessionLive.layer),
	Layer.provideMerge(Event.layer),
	Layer.provideMerge(Database.layer(":memory:")),
);
const { effect: itWatched } = testEffect(watched);

describe("Control.update", () => {
	itWatched("moves a pending prompt between lanes in place, waking only for the steer lane", () =>
		Effect.gen(function* () {
			const { control, sessionId, threadId } = yield* setup;
			const later = yield* control.prompt({ sessionId, prompt: prompt("Later"), delivery: "followUp" });
			const steer = yield* control.prompt({ sessionId, prompt: prompt("Now") });
			wakes.length = 0;

			expect(yield* control.update(threadId, later.id, { delivery: "steer" })).toBe(true);
			expect((yield* control.pending(threadId)).map((input) => [input.id, input.delivery])).toEqual([
				[later.id, "steer"],
				[steer.id, "steer"],
			]);
			expect(wakes).toEqual([threadId]);

			wakes.length = 0;
			expect(yield* control.update(threadId, steer.id, { delivery: "followUp" })).toBe(true);
			expect((yield* control.pending(threadId)).map((input) => [input.id, input.delivery])).toEqual([
				[later.id, "steer"],
				[steer.id, "followUp"],
			]);
			expect(wakes).toEqual([]);
			expect(yield* eventCount("session.prompt.updated.1")).toBe(2);
		}),
	);

	// "Send now" on a steer left waiting by a stop: the lane is unchanged, but the move is recorded, since
	// that is what makes the parked prompt run, now or after a crash.
	itWatched("records and wakes a move to the steer lane for a steer already in it", () =>
		Effect.gen(function* () {
			const { control, sessionId, threadId } = yield* setup;
			const steer = yield* control.prompt({ sessionId, prompt: prompt("Parked") });
			wakes.length = 0;

			expect(yield* control.update(threadId, steer.id, { delivery: "steer" })).toBe(true);

			expect(wakes).toEqual([threadId]);
			expect(yield* eventCount("session.prompt.updated.1")).toBe(1);
		}),
	);

	it("rewrites a pending prompt in place, and the promotion carries the new text", () =>
		Effect.gen(function* () {
			const { threads, control, sessionId, threadId } = yield* setup;
			const inputs = yield* Inbox.make;
			const first = yield* control.prompt({ sessionId, prompt: prompt("Fix the tests") });
			const second = yield* control.prompt({ sessionId, prompt: prompt("Then lint") });

			expect(yield* control.update(threadId, first.id, { prompt: prompt("Fix the flaky test only") })).toBe(true);
			expect((yield* control.pending(threadId)).map((input) => input.id)).toEqual([first.id, second.id]);

			yield* inputs.promote(threadId, Number.MAX_SAFE_INTEGER, "postTools");
			const line = yield* threads.line(threadId);
			expect(line.map((h) => h.entry.id)).toEqual([first.id, second.id]);
			expect(ContextCodec.parts(yield* ContextCodec.decodeMessage(line[0]!))[0]).toMatchObject({
				text: "Fix the flaky test only",
			});
		}));

	it("refuses to update a promoted, cancelled, unknown or another session's prompt", () =>
		Effect.gen(function* () {
			const { sessions, control, sessionId, threadId } = yield* setup;
			const inputs = yield* Inbox.make;
			const { spaceId, location } = yield* seedSpace();
			const { thread: other } = yield* sessions.create({
				spaceId,
				directory: location,
				title: "Other",
				tag: "test",
			});
			const promoted = yield* control.prompt({ sessionId, prompt: prompt("Promoted") });
			yield* inputs.promote(threadId, Number.MAX_SAFE_INTEGER, "postTools");
			const cancelled = yield* control.prompt({ sessionId, prompt: prompt("Cancelled") });
			yield* control.cancel(threadId, cancelled.id);
			const pending = yield* control.prompt({ sessionId, prompt: prompt("Pending"), delivery: "followUp" });

			const refused = { delivery: "steer" as const, prompt: prompt("Changed") };
			expect(yield* control.update(threadId, promoted.id, refused)).toBe(false);
			expect(yield* control.update(threadId, cancelled.id, refused)).toBe(false);
			expect(yield* control.update(threadId, SessionMessageSchema.ID.make("msg_unknown"), refused)).toBe(false);
			expect(yield* control.update(ThreadSchema.ID.make(other.id), pending.id, refused)).toBe(false);

			expect(yield* eventCount("session.prompt.updated.1")).toBe(0);
			expect(yield* control.pending(threadId)).toMatchObject([{ id: pending.id, delivery: "followUp" }]);
		}));

	it("settles an update racing a promotion in one of its valid orders", () =>
		Effect.gen(function* () {
			const { threads, control, sessionId, threadId } = yield* setup;
			const inputs = yield* Inbox.make;
			const admitted = yield* control.prompt({ sessionId, prompt: prompt("Original") });

			const [updated, promoted] = yield* Effect.all(
				[
					control.update(threadId, admitted.id, { prompt: prompt("Rewritten") }),
					inputs.promote(threadId, Number.MAX_SAFE_INTEGER, "postTools"),
				],
				{ concurrency: "unbounded" },
			);

			// Three orders are valid: the rewrite commits first and is promoted; the promotion commits
			// first and the rewrite is refused; or the promotion selected the prompt before the rewrite
			// committed, then steps back and leaves the rewritten prompt pending.
			const line = yield* threads.line(threadId);
			if (promoted === 0) {
				expect(updated).toBe(true);
				expect(line).toEqual([]);
				expect(PromptSchema.Prompt.text((yield* control.pending(threadId))[0]!.prompt)).toBe("Rewritten");
			} else {
				expect(ContextCodec.parts(yield* ContextCodec.decodeMessage(line[0]!))[0]).toMatchObject({
					text: updated ? "Rewritten" : "Original",
				});
			}
			expect(yield* eventCount("session.prompt.updated.1")).toBe(updated ? 1 : 0);
		}));
});

describe("Control queue order", () => {
	it("keeps the others in order when a middle prompt is cancelled", () =>
		Effect.gen(function* () {
			const { control, sessionId, threadId } = yield* setup;
			const first = yield* control.prompt({ sessionId, prompt: prompt("First") });
			const middle = yield* control.prompt({ sessionId, prompt: prompt("Middle"), delivery: "followUp" });
			const last = yield* control.prompt({ sessionId, prompt: prompt("Last") });

			yield* control.cancel(threadId, middle.id);

			expect((yield* control.pending(threadId)).map((input) => input.id)).toEqual([first.id, last.id]);
		}));

	it("does not turn an unrelated projector defect into a lost update", () =>
		Effect.gen(function* () {
			const { control, sessionId, threadId } = yield* setup;
			const events = yield* Event.Service;
			const admitted = yield* control.prompt({ sessionId, prompt: prompt(text), delivery: "followUp" });
			const defect = new Error("projector failed");
			yield* events.project(EventList.PromptUpdated, () => Effect.die(defect));

			const exit = yield* control.update(threadId, admitted.id, { delivery: "steer" }).pipe(Effect.exit);

			expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(defect);
			expect(yield* eventCount("session.prompt.updated.1")).toBe(0);
			expect(yield* control.pending(threadId)).toMatchObject([{ id: admitted.id, delivery: "followUp" }]);
		}));
});

describe("Control queue races", () => {
	// The promotion selected the prompts, then one changed before its own promotion committed. That
	// promotion must step back, not fail the drain, and the next one carries the new content.
	it("steps a promotion back when its prompt was updated after selection", () =>
		Effect.gen(function* () {
			const { threads, control, sessionId, threadId } = yield* setup;
			const inputs = yield* Inbox.make;
			const events = yield* Event.Service;
			const first = yield* control.prompt({ sessionId, prompt: prompt("First") });
			const second = yield* control.prompt({ sessionId, prompt: prompt("Second") });
			let rewritten = false;
			yield* events.listen((event) =>
				!rewritten && Schema.is(EventList.Prompted)(event) && event.data.messageId === first.id
					? Effect.gen(function* () {
							rewritten = true;
							yield* control.update(threadId, second.id, { prompt: prompt("Second, rewritten") });
						})
					: Effect.void,
			);

			expect(yield* inputs.promote(threadId, Number.MAX_SAFE_INTEGER, "postTools")).toBe(1);
			expect(rewritten).toBe(true);
			expect(yield* control.pending(threadId)).toMatchObject([{ id: second.id }]);

			expect(yield* inputs.promote(threadId, Number.MAX_SAFE_INTEGER, "postTools")).toBe(1);
			const line = yield* threads.line(threadId);
			expect(line.map((h) => h.entry.id)).toEqual([first.id, second.id]);
			expect(ContextCodec.parts(yield* ContextCodec.decodeMessage(line[1]!))[0]).toMatchObject({
				text: "Second, rewritten",
			});
		}));

	// The prompt was cancelled and sent again, unchanged, after the promotion selected it: the stale
	// promotion steps back and the next one promotes the new admission.
	it("steps a promotion back when its prompt was cancelled and re-admitted after selection", () =>
		Effect.gen(function* () {
			const { threads, control, sessionId, threadId } = yield* setup;
			const inputs = yield* Inbox.make;
			const events = yield* Event.Service;
			const first = yield* control.prompt({ sessionId, prompt: prompt("First") });
			const second = { sessionId, id: SessionMessageSchema.ID.make("msg_second"), prompt: prompt("Second") };
			const before = yield* control.prompt(second);
			let resent = false;
			yield* events.listen((event) =>
				!resent && Schema.is(EventList.Prompted)(event) && event.data.messageId === first.id
					? Effect.gen(function* () {
							resent = true;
							yield* control.cancel(threadId, second.id);
							// Sent again later, as a person would: the new admission's time differs.
							yield* TestClock.adjust("1 second");
							yield* control.prompt(second);
						}).pipe(Effect.orDie)
					: Effect.void,
			);

			expect(yield* inputs.promote(threadId, Number.MAX_SAFE_INTEGER, "postTools")).toBe(1);
			expect(resent).toBe(true);
			const [pending] = yield* control.pending(threadId);
			expect(pending?.id).toBe(second.id);
			expect(pending!.admittedSeq).toBeGreaterThan(before.admittedSeq);

			expect(yield* inputs.promote(threadId, Number.MAX_SAFE_INTEGER, "postTools")).toBe(1);
			expect((yield* threads.line(threadId)).map((h) => h.entry.id)).toEqual([first.id, second.id]);
		}));

	// Two updates of different fields, the second computed before the first committed: each event
	// carries only its own field, so the first one's change survives.
	it("applies only the field an update changes", () =>
		Effect.gen(function* () {
			const { control, sessionId, threadId } = yield* setup;
			const events = yield* Event.Service;
			const admitted = yield* control.prompt({ sessionId, prompt: prompt("Original") });
			yield* control.update(threadId, admitted.id, { prompt: prompt("Rewritten") });

			yield* events.publish(EventList.PromptUpdated, {
				sessionId,
				threadId,
				messageId: admitted.id,
				timestamp: admitted.timeCreated,
				delivery: "followUp",
			});

			const [pending] = yield* control.pending(threadId);
			expect(pending?.delivery).toBe("followUp");
			expect(PromptSchema.Prompt.text(pending!.prompt)).toBe("Rewritten");
		}));

	it("does not report a re-admission as accepted when its projector fails", () =>
		Effect.gen(function* () {
			const { control, sessionId, threadId } = yield* setup;
			const events = yield* Event.Service;
			const input = { sessionId, id: messageId, prompt: prompt(text) };
			yield* control.prompt(input);
			yield* control.cancel(threadId, messageId);
			yield* events.project(EventList.PromptAdmitted, () => Effect.die(new Error("projector failed")));

			const exit = yield* control.prompt(input).pipe(Effect.exit);

			expect(Exit.isFailure(exit)).toBe(true);
			expect(yield* control.pending(threadId)).toEqual([]);
		}));
});

describe("Control unfinished runs", () => {
	const unfinished = (threadId: string) =>
		Effect.gen(function* () {
			const threads = yield* Thread.Service;
			return (yield* threads.unfinished).some((row) => row.id === threadId);
		});
	const end = (
		event: typeof EventList.RunFailed | typeof EventList.ExecutionInterrupted,
		ids: {
			readonly sessionId: SessionSchema.ID;
			readonly threadId: ThreadSchema.ID;
		},
	) =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			const timestamp = yield* DateTime.now;
			if (event === EventList.RunFailed)
				return yield* events.publish(EventList.RunFailed, {
					...ids,
					timestamp,
					reason: "truncated",
					message: "cut",
				});
			return yield* events.publish(EventList.ExecutionInterrupted, { ...ids, timestamp, reason: "user" });
		});

	// The admission itself records what makes the prompt run: a crash right after accepting it must not lose it.
	it("leaves an accepted prompt runnable, and unfinished, from its admission", () =>
		Effect.gen(function* () {
			const { threads, control, sessionId, threadId } = yield* setup;
			expect(yield* threads.runnable(threadId)).toBe(false);

			yield* control.prompt({ sessionId, prompt: prompt(text) });

			expect(yield* threads.runnable(threadId)).toBe(true);
			expect(yield* unfinished(threadId)).toBe(true);
		}));

	it("parks what an unanswered end leaves queued; a later prompt or a move to steer wakes it", () =>
		Effect.gen(function* () {
			const { threads, control, sessionId, threadId } = yield* setup;
			const queued = yield* control.prompt({ sessionId, prompt: prompt("Queued"), delivery: "followUp" });

			yield* end(EventList.RunFailed, { sessionId, threadId });
			expect(yield* threads.runnable(threadId)).toBe(false);
			expect(yield* unfinished(threadId)).toBe(false);

			yield* control.update(threadId, queued.id, { delivery: "steer" });
			expect(yield* threads.runnable(threadId)).toBe(true);

			// A user stop parks the same way, and a prompt sent after it is runnable again.
			yield* end(EventList.ExecutionInterrupted, { sessionId, threadId });
			expect(yield* threads.runnable(threadId)).toBe(false);
			yield* control.prompt({ sessionId, prompt: prompt("After the stop") });
			expect(yield* threads.runnable(threadId)).toBe(true);
		}));
});
