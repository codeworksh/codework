import "./utils/env.ts";

import { createAssistantMessageEventStream, Message } from "@codeworksh/aikit";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { LLMEventPublisher } from "../src/runner/event.ts";
import { LLM } from "../src/runner/llm.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { AbsolutePath } from "../src/schema.ts";
import { SessionLive } from "../src/session/live.ts";
import { Session } from "../src/session/session.ts";
import { testEffect } from "./utils/effect.ts";

const layer = SessionLive.layer.pipe(Layer.provideMerge(Event.layer), Layer.provideMerge(Database.layer(":memory:")));
const { effect: it } = testEffect(layer);

const setup = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`INSERT OR IGNORE INTO project (id, name, created_at, updated_at) VALUES ('local','local',0,0)`;
	const sessions = yield* Session.Service;
	const session = yield* sessions.create({
		projectId: "local",
		slug: `provider-${crypto.randomUUID()}`,
		directory: AbsolutePath.make("/repo"),
		title: "Provider test",
		tag: "test",
		sandboxInstanceId: SandboxInstance.ID.local,
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
			const { sessionId, publisher } = yield* setup;
			const failure = yield* LLM.run({
				sessionId,
				context,
				provider: "openai",
				model: "model-that-does-not-exist",
				publisher,
			}).pipe(Effect.flip);

			expect(failure._tag).toBe("Runner.ModelNotFoundError");
			expect(failure).toMatchObject({ provider: "openai", model: "model-that-does-not-exist" });
		}),
	);

	it(
		"maps an async iterator failure to ProviderTurnError",
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
				publisher,
			}).pipe(Effect.flip);

			expect(failure._tag).toBe("Runner.ProviderTurnError");
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
				publisher,
			}).pipe(Effect.flip);

			expect(failure._tag).toBe("Runner.LLMStreamError");
			if (failure._tag !== "Runner.LLMStreamError") return yield* Effect.die("unexpected LLM failure type");
			expect(failure.reason).toContain("without a terminal event");
		}),
	);
});
