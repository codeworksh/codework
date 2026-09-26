import type { Message } from "@codeworksh/aikit";
import { DateTime, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { EventList } from "../src/event/list.ts";
import { seedSpace } from "./fixtures/space.ts";
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
	const { spaceId, location } = yield* seedSpace();
	const sessions = yield* Session.Service;
	const session = yield* sessions.create({
		spaceId,
		slug: "llm",
		directory: location,
		title: "T",
		tag: "test",
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

describe("LLM terminal projection", () => {
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
});
