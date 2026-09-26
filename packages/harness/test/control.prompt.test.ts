import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { Control } from "../src/control.ts";
import { ContextCodec } from "../src/context/codec.ts";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { RunnerExecution } from "../src/runner/execution.ts";
import { SessionInput } from "../src/session/input/input.ts";
import { SessionLive } from "../src/session/live.ts";
import { SessionMessageSchema } from "../src/session/message/schema.ts";
import { PromptSchema } from "../src/session/prompt/schema.ts";
import { Session } from "../src/session/session.ts";
import { seedSpace } from "./fixtures/space.ts";
import { testEffect } from "./utils/effect.ts";

// `Option` has no `.value` on the union — these tests treat a missing row as a
// bug in the code under test, not a case to handle.
const some = <A>(option: Option.Option<A>): A => Option.getOrThrow(option);

const layer = Control.layer.pipe(
	// Admission is the whole subject here, so there is nothing to drain and the
	// wake has nowhere to go.
	Layer.provide(RunnerExecution.noopLayer),
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
	const session = yield* sessions.create({
		spaceId,
		slug: "prompted",
		directory: location,
		title: "T",
		tag: "test",
	});
	return { sessions, control: yield* Control.Service, sessionId: session.id };
});

const admittedCount = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	return (yield* sql`SELECT id FROM session_input`).length;
});

const eventCount = (type: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		return (yield* sql`SELECT id FROM event WHERE type = ${type}`).length;
	});

const prompt = (text: string) => PromptSchema.Prompt.make({ text });

describe("Control.prompt", () => {
	it("returns the original record when the id is retried", () =>
		Effect.gen(function* () {
			const { sessions, control, sessionId } = yield* setup;
			const input = { sessionId, id: messageId, prompt: prompt(text) };

			const first = yield* control.prompt(input);
			const retried = yield* control.prompt(input);

			expect(retried).toEqual(first);
			expect(yield* admittedCount).toBe(1);
			expect(yield* sessions.path(sessionId)).toEqual([]);
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
			const { sessions, control, sessionId } = yield* setup;
			const inputs = yield* SessionInput.make;
			const admitted = yield* control.prompt({ sessionId, id: messageId, prompt: prompt("Promote once") });

			const counts = yield* Effect.all(
				[
					inputs.promoteSteers(sessionId, Number.MAX_SAFE_INTEGER),
					inputs.promoteSteers(sessionId, Number.MAX_SAFE_INTEGER),
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
			const path = yield* sessions.path(sessionId);
			expect(path.map((h) => h.entry.id)).toEqual([messageId]);
			expect(path[0]!.entry.seq).toBe(promoted.promotedSeq);
			expect((yield* ContextCodec.decodeMessage(path[0]!)).parts[0]).toMatchObject({
				type: "text",
				text: "Promote once",
			});
		}));

	it("reports the follow-up to whichever caller won it", () =>
		Effect.gen(function* () {
			const { control, sessionId } = yield* setup;
			const inputs = yield* SessionInput.make;
			yield* control.prompt({ sessionId, prompt: prompt("Later"), delivery: "followUp" });

			const won = yield* Effect.all([inputs.promoteFollowUp(sessionId), inputs.promoteFollowUp(sessionId)], {
				concurrency: "unbounded",
			});

			expect(won.filter(Boolean).length).toBe(1);
			expect(yield* eventCount("session.prompt.promoted.1")).toBe(1);
			expect(yield* inputs.hasPending(sessionId, "followUp")).toBe(false);
		}));

	it("promotes steers only through the captured cutoff", () =>
		Effect.gen(function* () {
			const { sessions, control, sessionId } = yield* setup;
			const inputs = yield* SessionInput.make;
			const first = yield* control.prompt({ sessionId, prompt: prompt("Before cutoff") });
			const cutoff = first.admittedSeq;
			const second = yield* control.prompt({ sessionId, prompt: prompt("After cutoff") });

			yield* inputs.promoteSteers(sessionId, cutoff);

			expect(some(yield* inputs.find(first.id)).promotedSeq).toBeDefined();
			expect(some(yield* inputs.find(second.id)).promotedSeq).toBeUndefined();
			expect((yield* sessions.path(sessionId)).map((h) => h.entry.id)).toEqual([first.id]);
		}));
});
