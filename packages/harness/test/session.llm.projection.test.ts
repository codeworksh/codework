import type { Message } from "@codeworksh/aikit";
import { DateTime, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { EventList } from "../src/event/list.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { AbsolutePath } from "../src/schema.ts";
import { SessionLive } from "../src/session/live.ts";
import { SessionMessageSchema } from "../src/session/message/schema.ts";
import { Session } from "../src/session/session.ts";
import { testEffect } from "./utils/effect.ts";

/**
 * The output half on its own: publish the terminal aikit events and assert what
 * reaches `session_entry`. No loop, no publisher, no provider — the whole point
 * of splitting the phases is that this side is provable without them.
 */
const layer = SessionLive.layer.pipe(Layer.provideMerge(Event.layer), Layer.provideMerge(Database.layer(":memory:")));
const { effect: it } = testEffect(layer);

const setup = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`INSERT OR IGNORE INTO project (id, name, created_at, updated_at) VALUES ('local','local',0,0)`;
	const sessions = yield* Session.Service;
	const session = yield* sessions.create({
		projectId: "local",
		slug: "llm",
		directory: AbsolutePath.make("/repo"),
		title: "T",
		tag: "test",
		sandboxInstanceId: SandboxInstance.ID.local,
	});
	return { sessions, events: yield* Event.Service, sessionId: session.id };
});

const messageId = SessionMessageSchema.ID.create();

/** A terminal assistant message, shaped exactly as aikit would hand it over. */
const assistant = (overrides: Partial<Message.AssistantMessage> = {}): Message.AssistantMessage => ({
	messageId,
	role: "assistant",
	protocol: "anthropic",
	provider: { id: "anthropic", name: "Anthropic", source: "custom", env: [] },
	model: "claude-test",
	usage: {
		input: 11,
		output: 22,
		cacheRead: 3,
		cacheWrite: 4,
		totalTokens: 33,
		cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
	},
	stopReason: "stop",
	time: { created: 10, completed: 20 },
	parts: [{ type: "text", text: "the answer" }],
	...overrides,
});

const usageTotals = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	// The client is configured with `transformResultNames: snakeToCamel`, so the
	// columns come back camelCased even from a raw query.
	const rows = yield* sql`SELECT cost, tokens_input, tokens_output, tokens_cache_read FROM session`;
	return rows[0] as { cost: number; tokensInput: number; tokensOutput: number; tokensCacheRead: number };
});

const eventCount = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	return (yield* sql`SELECT id FROM event`).length;
});

describe("LLM terminal projection", () => {
	it("appends one assistant entry from session.llm.ended", () =>
		Effect.gen(function* () {
			const { sessions, events, sessionId } = yield* setup;
			const message = assistant();

			const published = yield* events.publish(EventList.LLMEnded, {
				sessionId,
				messageId,
				timestamp: DateTime.makeUnsafe(0),
				reason: "stop",
				message,
			});

			const path = yield* sessions.path(sessionId);
			expect(path.length).toBe(1);
			const [entry] = path;
			// The entry is the message: same id, and positioned by the event that
			// produced it rather than by a counter of its own.
			expect(entry!.entry.id).toBe(messageId);
			expect(entry!.entry.type).toBe("assistant");
			expect(entry!.entry.seq).toBe(published.durable?.seq);

			// Parts are split out of the envelope and stored dense, in order.
			expect(entry!.parts.map((part) => part.type)).toEqual(["text"]);
			expect(JSON.parse(entry!.parts[0]!.data)).toEqual({ type: "text", text: "the answer" });
			expect(JSON.parse(entry!.entry.data)).toMatchObject({ role: "assistant", stopReason: "stop" });
		}));

	it("stores a failed response the same way, keeping what the model produced", () =>
		Effect.gen(function* () {
			const { sessions, events, sessionId } = yield* setup;

			yield* events.publish(EventList.LLMFailed, {
				sessionId,
				messageId,
				timestamp: DateTime.makeUnsafe(0),
				reason: "aborted",
				// aikit reports an abort as a complete message carrying everything
				// generated before it, so the partial text is history, not a loss.
				message: assistant({
					stopReason: "aborted",
					errorMessage: "Request was aborted",
					parts: [{ type: "text", text: "half an ans" }],
				}),
			});

			const path = yield* sessions.path(sessionId);
			expect(path.map((item) => item.entry.type)).toEqual(["assistant"]);
			expect(JSON.parse(path[0]!.entry.data)).toMatchObject({
				stopReason: "aborted",
				errorMessage: "Request was aborted",
			});
			expect(JSON.parse(path[0]!.parts[0]!.data)).toEqual({ type: "text", text: "half an ans" });
		}));

	it("charges usage once, from the terminal message", () =>
		Effect.gen(function* () {
			const { events, sessionId } = yield* setup;
			expect((yield* usageTotals).tokensInput).toBe(0);

			yield* events.publish(EventList.LLMEnded, {
				sessionId,
				messageId,
				timestamp: DateTime.makeUnsafe(0),
				reason: "stop",
				message: assistant(),
			});

			const totals = yield* usageTotals;
			expect(totals.tokensInput).toBe(11);
			expect(totals.tokensOutput).toBe(22);
			expect(totals.tokensCacheRead).toBe(3);
			expect(totals.cost).toBeCloseTo(0.3);
		}));

	it("rolls back the entry, the event row, and the sequence when the ids disagree", () =>
		Effect.gen(function* () {
			const { sessions, events, sessionId } = yield* setup;
			const before = yield* events.latestSequence(sessionId);

			// The event names one message, the payload names another. Storing this
			// would put the entry under an id its own envelope contradicts.
			const failure = yield* events
				.publish(EventList.LLMEnded, {
					sessionId,
					messageId,
					timestamp: DateTime.makeUnsafe(0),
					reason: "stop",
					message: assistant({ messageId: SessionMessageSchema.ID.create() }),
				})
				.pipe(Effect.exit);

			expect(failure._tag).toBe("Failure");
			// A projector runs inside the commit, so its rejection takes the event and
			// the sequence allocation down with it — not just the entry.
			expect(yield* sessions.path(sessionId)).toEqual([]);
			expect(yield* eventCount).toBe(0);
			expect(yield* events.latestSequence(sessionId)).toBe(before);
		}));

	it("lands after a user entry, so the transcript reads in order", () =>
		Effect.gen(function* () {
			const { sessions, events, sessionId } = yield* setup;
			const userId = SessionMessageSchema.ID.create();

			yield* events.publish(EventList.Prompted, {
				sessionId,
				messageId: userId,
				timestamp: DateTime.makeUnsafe(0),
				prompt: { text: "ask" },
				delivery: "steer",
			});
			yield* events.publish(EventList.LLMEnded, {
				sessionId,
				messageId,
				timestamp: DateTime.makeUnsafe(0),
				reason: "stop",
				message: assistant(),
			});

			const path = yield* sessions.path(sessionId);
			expect(path.map((item) => item.entry.id)).toEqual([userId, messageId]);
			expect(path.map((item) => item.entry.type)).toEqual(["user", "assistant"]);
			// Both positions come from the same log, so the assistant is strictly above
			// the prompt it answers.
			expect(path[1]!.entry.seq).toBeGreaterThan(path[0]!.entry.seq);
		}));
});
