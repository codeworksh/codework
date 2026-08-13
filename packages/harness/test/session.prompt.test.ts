import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { SessionInput } from "../src/session/input/input.ts";
import { SessionMessageSchema } from "../src/session/message/schema.ts";
import { SessionProjector } from "../src/session/projector.ts";
import { PromptSchema } from "../src/session/prompt/schema.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { Session } from "../src/session/session.ts";
import { AbsolutePath } from "../src/schema.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { testEffect } from "./utils/effect.ts";

// `Option` has no `.value` on the union — these tests treat a missing row as a
// bug in the code under test, not a case to handle.
const some = <A>(option: Option.Option<A>): A => Option.getOrThrow(option);



const layer = Layer.provideMerge(
	SessionProjector.layer,
	Session.layer.pipe(Layer.provideMerge(Event.layer), Layer.provideMerge(Database.layer(":memory:"))),
);
const { effect: it } = testEffect(layer);

const messageId = SessionMessageSchema.ID.make("msg_fixed");
const text = "Fix the failing tests";

const setup = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`INSERT OR IGNORE INTO project (id, name, created_at, updated_at) VALUES ('local','local',0,0)`;
	const sessions = yield* Session.Service;
	const session = yield* sessions.create({
		projectId: "local",
		slug: "prompted",
		directory: AbsolutePath.make("/repo"),
		title: "T",
		tag: "test",
		sandboxInstanceId: SandboxInstance.ID.local,
	});
	return { sessions, sessionId: session.id };
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

describe("Session.prompt", () => {
	it("mints a distinct id for each prompt when none is supplied", () =>
		Effect.gen(function* () {
			const { sessions, sessionId } = yield* setup;

			const first = yield* sessions.prompt({ sessionId, prompt: prompt(text) });
			const second = yield* sessions.prompt({ sessionId, prompt: prompt(text) });

			expect(second.id).not.toBe(first.id);
			expect(yield* admittedCount).toBe(2);
			// Admission alone does not put anything in the conversation.
			expect(yield* sessions.path(sessionId)).toEqual([]);
		}));

	it("returns the original record when the id is retried", () =>
		Effect.gen(function* () {
			const { sessions, sessionId } = yield* setup;
			const input = { sessionId, id: messageId, prompt: prompt(text) };

			const first = yield* sessions.prompt(input);
			const retried = yield* sessions.prompt(input);

			expect(retried).toEqual(first);
			expect(yield* admittedCount).toBe(1);
			expect(yield* sessions.path(sessionId)).toEqual([]);
		}));

	it("rejects reuse of one id with a different prompt", () =>
		Effect.gen(function* () {
			const { sessions, sessionId } = yield* setup;
			yield* sessions.prompt({ sessionId, id: messageId, prompt: prompt(text) });

			const failure = yield* sessions
				.prompt({ sessionId, id: messageId, prompt: prompt("Delete the failing tests") })
				.pipe(Effect.flip);

			expect(failure._tag).toBe("PromptConflictError");
			// The stored row survives untouched; the conflict changed nothing.
			expect(yield* admittedCount).toBe(1);
		}));

	it("rejects reuse of one id with a different delivery lane", () =>
		Effect.gen(function* () {
			const { sessions, sessionId } = yield* setup;
			yield* sessions.prompt({ sessionId, id: messageId, prompt: prompt(text) });

			const failure = yield* sessions
				.prompt({ sessionId, id: messageId, prompt: prompt(text), delivery: "followUp" })
				.pipe(Effect.flip);

			expect(failure._tag).toBe("PromptConflictError");
		}));

	it("returns one record to concurrent exact retries", () =>
		Effect.gen(function* () {
			const { sessions, sessionId } = yield* setup;
			const input = { sessionId, id: messageId, prompt: prompt(text) };

			const both = yield* Effect.all([sessions.prompt(input), sessions.prompt(input)], {
				concurrency: "unbounded",
			});

			expect(both[1]).toEqual(both[0]);
			expect(yield* admittedCount).toBe(1);
			// The loser's event rolled back with its projector, so only one exists.
			expect(yield* eventCount("session.next.prompt.admitted.1")).toBe(1);
		}));

	it("refuses a prompt for a session that does not exist", () =>
		Effect.gen(function* () {
			const { sessions } = yield* setup;
			const failure = yield* sessions
				.prompt({ sessionId: SessionSchema.ID.make("ses_nope"), prompt: prompt(text) })
				.pipe(Effect.flip);

			expect(failure._tag).toBe("SessionNotFoundError");
			expect(yield* admittedCount).toBe(0);
		}));

	it("promotes once under concurrent promotion attempts", () =>
		Effect.gen(function* () {
			const { sessions, sessionId } = yield* setup;
			const inputs = yield* SessionInput.make;
			const admitted = yield* sessions.prompt({ sessionId, id: messageId, prompt: prompt("Promote once") });

			yield* Effect.all(
				[
					inputs.promoteSteers(sessionId, Number.MAX_SAFE_INTEGER),
					inputs.promoteSteers(sessionId, Number.MAX_SAFE_INTEGER),
				],
				{ concurrency: "unbounded" },
			);

			expect(yield* eventCount("session.next.prompt.promoted.1")).toBe(1);
			const promoted = some(yield* inputs.find(admitted.id));
			expect(promoted.promotedSeq).toBeDefined();

			// Promotion is what puts the prompt in the conversation, and the entry
			// carries the promoting event's position.
			const path = yield* sessions.path(sessionId);
			expect(path.map((h) => h.entry.id)).toEqual([messageId]);
			expect(path[0]!.entry.seq).toBe(promoted.promotedSeq);
			expect(JSON.parse(path[0]!.parts[0]!.data)).toMatchObject({ type: "text", text: "Promote once" });
		}));

	it("promotes steers only through the captured cutoff", () =>
		Effect.gen(function* () {
			const { sessions, sessionId } = yield* setup;
			const inputs = yield* SessionInput.make;
			const first = yield* sessions.prompt({ sessionId, prompt: prompt("Before cutoff") });
			const cutoff = first.admittedSeq;
			const second = yield* sessions.prompt({ sessionId, prompt: prompt("After cutoff") });

			yield* inputs.promoteSteers(sessionId, cutoff);

			expect(some(yield* inputs.find(first.id)).promotedSeq).toBeDefined();
			expect(some(yield* inputs.find(second.id)).promotedSeq).toBeUndefined();
			expect((yield* sessions.path(sessionId)).map((h) => h.entry.id)).toEqual([first.id]);
		}));
});
