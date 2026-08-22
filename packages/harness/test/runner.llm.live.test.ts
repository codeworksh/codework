import "./utils/env.ts";

import { Message } from "@codeworksh/aikit";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Ref } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { ContextCodec } from "../src/context/codec.ts";
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
const suite = testEffect(layer);
const openaiLiveIt = process.env.OPENAI_API_KEY ? suite.live : suite.live.skip;

const setup = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`INSERT OR IGNORE INTO project (id, name, created_at, updated_at) VALUES ('local','local',0,0)`;
	const sessions = yield* Session.Service;
	const session = yield* sessions.create({
		projectId: "local",
		slug: `provider-${crypto.randomUUID()}`,
		directory: AbsolutePath.make("/repo"),
		title: "Provider live test",
		tag: "test",
		sandboxInstanceId: SandboxInstance.ID.local,
	});
	return { sql, sessions, sessionId: session.id };
});

const context = (text: string): Message.Context => ({
	systemPrompt: "Follow the user instruction exactly.",
	messages: [
		Message.createUserMessage({
			role: "user",
			time: { created: Date.now() },
			parts: [{ type: "text", text }],
		}),
	],
});

describe("runner LLM — OpenAI live", () => {
	openaiLiveIt(
		"persists finalized thinking from a real provider response",
		Effect.gen(function* () {
			const { sql, sessions, sessionId } = yield* setup;
			const events = yield* Event.Service;
			const thinkingDeltas = yield* Ref.make(0);
			const removeListener = yield* events.listen((event) =>
				event.type === "session.llm.thinking.delta"
					? Ref.update(thinkingDeltas, (count) => count + 1)
					: Effect.void,
			);
			yield* Effect.addFinalizer(() => removeListener);

			const publisher = yield* LLMEventPublisher.make({ sessionId });
			const terminal = yield* LLM.run({
				sessionId,
				context: context(
					"Solve carefully: find the smallest positive integer divisible by every integer from 1 through 12. Reply with the number and one short verification sentence.",
				),
				provider: "openai",
				model: "gpt-5.5",
				publisher,
			});

			expect(terminal.outcome).toBe("ended");
			expect(yield* Ref.get(thinkingDeltas)).toBeGreaterThan(0);
			const path = yield* sessions.path(sessionId);
			expect(path.map((item) => item.entry.type)).toEqual(["assistant"]);
			expect(path[0]!.entry.state).toBe("draft");
			expect(JSON.parse(path[0]!.entry.data)).toMatchObject({ stopReason: "stop" });
			expect(path[0]!.parts.some((part) => part.type === "thinking")).toBe(true);

			const stored = yield* ContextCodec.decodeMessage(path[0]!);
			if (stored.role !== "assistant") return yield* Effect.die(`stored message is ${stored.role}, not assistant`);
			expect(stored.parts.some((part) => part.type === "thinking" && part.thinking.trim().length > 0)).toBe(true);

			const durable = yield* sql`SELECT type FROM event ORDER BY seq`;
			expect(durable.map((row) => row.type)).toEqual(["session.llm.started.1", "session.llm.ended.1"]);
		}),
		{ timeout: 180_000 },
	);

	openaiLiveIt(
		"bridges Effect interruption to a partless aborted tombstone",
		Effect.gen(function* () {
			const { sessions, sessionId } = yield* setup;
			const events = yield* Event.Service;
			const streaming = yield* Deferred.make<"thinking" | "text">();
			yield* events.listen((event) =>
				event.type === "session.llm.thinking.delta"
					? Deferred.succeed(streaming, "thinking").pipe(Effect.asVoid)
					: event.type === "session.llm.text.delta"
						? Deferred.succeed(streaming, "text").pipe(Effect.asVoid)
						: Effect.void,
			);

			const publisher = yield* LLMEventPublisher.make({ sessionId });
			const running = yield* LLM.run({
				sessionId,
				context: context("List 200 distinct first names, one per line."),
				provider: "openai",
				model: "gpt-5.5",
				publisher,
			}).pipe(Effect.forkChild);
			const interruptedPart = yield* Deferred.await(streaming);

			yield* Fiber.interrupt(running);
			const exit = yield* Fiber.await(running);
			expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);

			const path = yield* sessions.path(sessionId);
			expect(path.map((item) => item.entry.type)).toEqual(["assistant"]);
			expect(path[0]!.entry.state).toBe("aborted");
			const stored = yield* ContextCodec.decodeMessage(path[0]!);
			if (stored.role !== "assistant") return yield* Effect.die(`stored message is ${stored.role}, not assistant`);
			expect(stored.stopReason).toBe("aborted");
			expect(stored.parts).toEqual([]);
			expect(["thinking", "text"]).toContain(interruptedPart);
		}),
		{ timeout: 180_000 },
	);
});
