import "./utils/env.ts";

import { createAssistantMessageEventStream, Message } from "@codeworksh/aikit";
import { Effect, Layer } from "effect";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { LLMEventPublisher } from "../src/runner/event.ts";
import { LLM } from "../src/runner/llm.ts";
import { RelativePath } from "../src/schema.ts";
import { seedSpace } from "./fixtures/space.ts";
import { SessionLive } from "../src/session/live.ts";
import { Session } from "../src/session/session.ts";
import { testEffect } from "./utils/effect.ts";

const layer = SessionLive.layer.pipe(Layer.provideMerge(Event.layer), Layer.provideMerge(Database.layer(":memory:")));
const { effect: it } = testEffect(layer);

const setup = Effect.gen(function* () {
	const { spaceId } = yield* seedSpace();
	const sessions = yield* Session.Service;
	const session = yield* sessions.create({
		spaceId,
		slug: `provider-${crypto.randomUUID()}`,
		directory: RelativePath.make(""),
		title: "Provider test",
		tag: "test",
	});
	return { sessionId: session.id, publisher: yield* LLMEventPublisher.make({ sessionId: session.id }) };
});

const context: Message.Context = {
	messages: [
		Message.createUserMessage({
			role: "user",
			time: { created: 1 },
			parts: [{ type: "text", text: "hello" }],
		}),
	],
};

describe("runner LLM", () => {
	it(
		"maps an unknown model to ModelNotFoundError",
		Effect.gen(function* () {
			const failure = yield* LLM.resolve({
				provider: "openai",
				model: "model-that-does-not-exist",
			}).pipe(Effect.flip);

			expect(failure._tag).toBe("Runner.ModelNotFoundError");
			expect(failure).toMatchObject({ provider: "openai", model: "model-that-does-not-exist" });
		}),
	);

	it(
		"maps an async iterator failure to a typed ProviderError",
		Effect.gen(function* () {
			const { sessionId, publisher } = yield* setup;
			const request = LLM.make(() =>
				Effect.succeed({
					[Symbol.asyncIterator]() {
						return {
							next: () => Promise.reject(new Error("iterator failed")),
						};
					},
				}),
			);
			const failure = yield* request({
				sessionId,
				context,
				provider: "openai",
				model: "gpt-4o-mini",
				resolvedModel: yield* LLM.resolve({ provider: "openai", model: "gpt-4o-mini" }),
				publisher,
			}).pipe(Effect.flip);

			expect(failure._tag).toBe("Runner.ProviderError");
			if (failure._tag !== "Runner.ProviderError") return yield* Effect.die("unexpected LLM failure type");
			expect(failure.reason._tag).toBe("Runner.ProviderUnknownError");
			expect(failure.message).toBe("openai/gpt-4o-mini: iterator failed");
		}),
	);

	it(
		"rejects a stream that ends without a terminal event",
		Effect.gen(function* () {
			const { sessionId, publisher } = yield* setup;
			const request = LLM.make(() =>
				Effect.sync(() => {
					const events = createAssistantMessageEventStream();
					events.end();
					return events;
				}),
			);
			const failure = yield* request({
				sessionId,
				context,
				provider: "openai",
				model: "gpt-4o-mini",
				resolvedModel: yield* LLM.resolve({ provider: "openai", model: "gpt-4o-mini" }),
				publisher,
			}).pipe(Effect.flip);

			expect(failure._tag).toBe("Runner.LLMStreamError");
			if (failure._tag !== "Runner.LLMStreamError") return yield* Effect.die("unexpected LLM failure type");
			expect(failure.reason).toContain("without a terminal event");
		}),
	);
});
