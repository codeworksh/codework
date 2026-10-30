import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { EventList } from "../src/event/list.ts";
import { Inbox } from "../src/inbox/inbox.ts";
import { SessionMessageSchema } from "../src/session/message/schema.ts";
import { SessionProjector } from "../src/session/projector.ts";
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

const base = Session.storeLayer.pipe(Layer.provideMerge(Event.layer), Layer.provideMerge(Database.layer(":memory:")));
// Provided twice on purpose: a layer is built once per graph, so the projectors
// register once. Registering them per consumer instead would make every
// admission conflict with itself.
const wired = Layer.provideMerge(Layer.merge(SessionProjector.layer, SessionProjector.layer), base);

const { effect: it } = testEffect(wired);

const sessionId = SessionSchema.ID.make("ses_a");
const threadId = ThreadSchema.ID.make("thr_a");
const prompt = PromptSchema.Prompt.fromText("fix the bug");

const seedSessions = Effect.gen(function* () {
	const sessions = yield* Session.Service;
	const { spaceId, location } = yield* seedSpace();
	yield* sessions.create({ id: sessionId, mainThreadId: threadId, spaceId, directory: location });
});

const admit = (input: Inbox.Interface, text: string) =>
	input.admit({
		id: SessionMessageSchema.ID.create(),
		sessionId,
		threadId,
		prompt: PromptSchema.Prompt.fromText(text),
		delivery: "steer",
	});

const setup = Effect.gen(function* () {
	yield* seedSessions;
	return yield* Inbox.make;
});

describe("Inbox admission", () => {
	// An id that already became an entry has left the inbox for good.
	it("refuses an id that already graduated into an entry", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const input = yield* setup;
			const id = SessionMessageSchema.ID.create();
			yield* sql`
				INSERT INTO entry (id, session_id, thread_id, seq, committed_seq, type, state, data, created_at, updated_at)
				VALUES (${id}, ${sessionId}, ${threadId}, 1, 1, 'user', 'committed', '{}', 0, 0)
			`;

			const exit = yield* input.admit({ id, sessionId, threadId, prompt, delivery: "steer" }).pipe(Effect.exit);

			expect(exit._tag).toBe("Failure");
			// The projector rejected it inside the commit, so no event survives past `session.created`.
			expect((yield* sql<{ type: string }>`SELECT type FROM event`).map((row) => row.type)).toEqual([
				"session.created.1",
			]);
			expect((yield* sql`SELECT * FROM inbox`).length).toBe(0);
		}));
});

describe("Inbox projections", () => {
	// The projection is where publish-time context survives, because the log
	// itself never carried it.
	it("carries the promoting event's metadata onto the entry", () =>
		Effect.gen(function* () {
			const input = yield* setup;
			const events = yield* Event.Service;
			const threads = yield* Thread.Service;
			const admitted = yield* admit(input, "one");

			yield* events.publish(
				EventList.Prompted,
				{
					sessionId,
					threadId,
					timestamp: admitted.timeCreated,
					messageId: admitted.id,
					prompt: admitted.prompt,
					delivery: admitted.delivery,
				},
				{ metadata: { requestId: "req_7" } },
			);

			const line = yield* threads.line(threadId);
			expect(line.map((h) => h.entry.id)).toEqual([admitted.id]);
			expect(some(line[0]!.entry.metadata)).toEqual({ requestId: "req_7" });
		}));
});
