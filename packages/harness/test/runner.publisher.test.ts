import type { Message } from "@codeworksh/aikit";
import { Effect, Layer } from "effect";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { LLMEventPublisher } from "../src/runner/event.ts";
import { seedSpace } from "./fixtures/space.ts";
import { SessionLive } from "../src/session/live.ts";
import { Session } from "../src/session/session.ts";
import { testEffect } from "./utils/effect.ts";

/**
 * The publisher against a hand-built provider stream. aikit is never called: an
 * `LLMMessageEvent` is a plain value, so the whole translation layer is testable
 * by constructing the events a provider would have sent.
 */
const layer = SessionLive.layer.pipe(Layer.provideMerge(Event.layer), Layer.provideMerge(Database.layer(":memory:")));
const { effect: it } = testEffect(layer);

const setup = Effect.gen(function* () {
	const { spaceId, location } = yield* seedSpace();
	const sessions = yield* Session.Service;
	const session = yield* sessions.create({
		spaceId,
		slug: "pub",
		directory: location,
		title: "T",
		tag: "test",
	});
	return { sessions, sessionId: session.id, publisher: yield* LLMEventPublisher.make({ sessionId: session.id }) };
});

const messageId = "0193f0a0-0000-7000-8000-000000000001";

const assistant = (overrides: Partial<Message.AssistantMessage> = {}): Message.AssistantMessage => ({
	messageId,
	role: "assistant",
	protocol: "anthropic",
	provider: { id: "anthropic", name: "Anthropic", source: "custom", env: [] },
	model: "claude-test",
	usage: {
		input: 1,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 3,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	time: { created: 10, completed: 20 },
	parts: [{ type: "text", text: "hello" }],
	...overrides,
});

describe("LLMEventPublisher", () => {
	it("rejects a second terminal, so one response cannot become two entries", () =>
		Effect.gen(function* () {
			const { sessions, sessionId, publisher } = yield* setup;
			const message = assistant();
			yield* publisher.publish({ type: "start", partial: message });
			yield* publisher.publish({ type: "done", reason: "stop", message });

			const failure = yield* publisher.publish({ type: "done", reason: "stop", message }).pipe(Effect.flip);

			expect(failure._tag).toBe("Runner.LLMStreamError");
			expect(failure.reason).toContain("after the response had already terminated");
			expect((yield* sessions.path(sessionId)).length).toBe(1);
		}));

	it("rejects a message id that changes mid-response", () =>
		Effect.gen(function* () {
			const { publisher } = yield* setup;
			const message = assistant();
			yield* publisher.publish({ type: "start", partial: message });

			// Two responses interleaving on one stream would file half of one under
			// the other, so the identity is latched by the first event.
			const failure = yield* publisher
				.publish({ type: "text.start", partIndex: 0, partial: assistant({ messageId: "other-id" }) })
				.pipe(Effect.flip);

			expect(failure._tag).toBe("Runner.LLMStreamError");
			expect(failure.reason).toContain("changed mid-response");
		}));

	it("reports a stream that ended without terminating", () =>
		Effect.gen(function* () {
			const { sessions, sessionId, publisher } = yield* setup;
			const message = assistant();
			yield* publisher.publish({ type: "start", partial: message });
			yield* publisher.publish({ type: "text.end", partIndex: 0, content: "hello", partial: message });

			const failure = yield* publisher.terminal.pipe(Effect.flip);

			expect(failure._tag).toBe("Runner.LLMStreamError");
			expect(failure.reason).toContain("without a terminal event");
			const path = yield* sessions.path(sessionId);
			expect(path).toHaveLength(1);
			expect(path[0]!.entry.state).toBe("draft");
		}));
});
