import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { EventList } from "../src/event/list.ts";
import { SessionInput } from "../src/session/input/input.ts";
import { SessionMessageSchema } from "../src/session/message/schema.ts";
import { SessionProjector } from "../src/session/projector.ts";
import { PromptSchema } from "../src/session/prompt/schema.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { Session } from "../src/session/session.ts";
import { seedSpace } from "./fixtures/space.ts";
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

const sessionId = SessionSchema.ID.make("ses_a");
const prompt = PromptSchema.Prompt.make({ text: "fix the bug" });

const seedSessions = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const { spaceId, location } = yield* seedSpace();
	yield* sql`
		INSERT INTO session (id, space_id, slug, directory, title, tag, created_at, updated_at)
		VALUES (${sessionId}, ${spaceId}, ${sessionId}, ${location}, 'T', 'test', 0, 0)
	`;
});

const admit = (input: SessionInput.Interface, text: string) =>
	input.admit({
		id: SessionMessageSchema.ID.create(),
		sessionId,
		prompt: PromptSchema.Prompt.make({ text }),
		delivery: "steer",
	});

const setup = Effect.gen(function* () {
	yield* seedSessions;
	return yield* SessionInput.make;
});

describe("SessionInput admission", () => {
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
});

describe("SessionInput projections", () => {
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
});
