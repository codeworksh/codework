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

const draft = () =>
	assistant({
		parts: [],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
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
	it("inserts a draft at start, fills it in place, and commits it at turn end", () =>
		Effect.gen(function* () {
			const { sessions, events, sessionId } = yield* setup;
			const message = assistant();

			const started = yield* events.publish(EventList.LLMStarted, {
				sessionId,
				messageId,
				timestamp: DateTime.makeUnsafe(0),
				message: draft(),
			});
			yield* events.publish(EventList.LLMEnded, {
				sessionId,
				messageId,
				timestamp: DateTime.makeUnsafe(0),
				reason: "stop",
				message,
			});

			const path = yield* sessions.path(sessionId);
			expect(path.length).toBe(1);
			const [entry] = path;
			// LLMEnded replaces the placeholder rather than appending or moving it.
			expect(entry!.entry.id).toBe(messageId);
			expect(entry!.entry.type).toBe("assistant");
			expect(entry!.entry.seq).toBe(started.durable?.seq);
			expect(entry!.entry.state).toBe("draft");

			// Parts are split out of the envelope and stored dense, in order.
			expect(entry!.parts.map((part) => part.type)).toEqual(["text"]);
			expect(JSON.parse(entry!.parts[0]!.data)).toEqual({ type: "text", text: "the answer" });
			expect(JSON.parse(entry!.entry.data)).toMatchObject({ role: "assistant", stopReason: "stop" });

			yield* events.publish(EventList.TurnEnded, {
				sessionId,
				messageId,
				timestamp: DateTime.makeUnsafe(0),
			});
			expect((yield* sessions.path(sessionId))[0]!.entry.state).toBe("committed");
		}));

	it("aborts the whole draft and discards partial response parts", () =>
		Effect.gen(function* () {
			const { sessions, events, sessionId } = yield* setup;

			yield* events.publish(EventList.LLMStarted, {
				sessionId,
				messageId,
				timestamp: DateTime.makeUnsafe(0),
				message: draft(),
			});
			yield* events.publish(EventList.LLMFailed, {
				sessionId,
				messageId,
				timestamp: DateTime.makeUnsafe(0),
				reason: "aborted",
				message: assistant({
					stopReason: "aborted",
					errorMessage: "Request was aborted",
					parts: [{ type: "text", text: "half an ans" }],
				}),
			});

			const path = yield* sessions.path(sessionId);
			expect(path.map((item) => item.entry.type)).toEqual(["assistant"]);
			expect(path[0]!.entry.state).toBe("aborted");
			expect(JSON.parse(path[0]!.entry.data)).toMatchObject({
				stopReason: "aborted",
				errorMessage: "Request was aborted",
			});
			expect(path[0]!.parts).toEqual([]);
		}));

	it("charges usage once, from the terminal message", () =>
		Effect.gen(function* () {
			const { events, sessionId } = yield* setup;
			expect((yield* usageTotals).tokensInput).toBe(0);

			yield* events.publish(EventList.LLMStarted, {
				sessionId,
				messageId,
				timestamp: DateTime.makeUnsafe(0),
				message: draft(),
			});
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
			const started = yield* events.publish(EventList.LLMStarted, {
				sessionId,
				messageId,
				timestamp: DateTime.makeUnsafe(0),
				message: draft(),
			});
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
			// The rejected fill rolls itself back without disturbing the earlier draft.
			const path = yield* sessions.path(sessionId);
			expect(path).toHaveLength(1);
			expect(path[0]!.entry.seq).toBe(started.durable?.seq);
			expect(path[0]!.entry.state).toBe("draft");
			expect(yield* eventCount).toBe(1);
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
			const started = yield* events.publish(EventList.LLMStarted, {
				sessionId,
				messageId,
				timestamp: DateTime.makeUnsafe(0),
				message: draft(),
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
			// The assistant keeps the position allocated by LLMStarted.
			expect(path[1]!.entry.seq).toBe(started.durable?.seq);
			expect(path[1]!.entry.seq).toBeGreaterThan(path[0]!.entry.seq);
		}));
});
