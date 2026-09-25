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
import { seedSpace } from "./fixtures/space.ts";
import { SessionLive } from "../src/session/live.ts";
import { Session } from "../src/session/session.ts";
import { testEffect } from "./utils/effect.ts";

const layer = SessionLive.layer.pipe(Layer.provideMerge(Event.layer), Layer.provideMerge(Database.layer(":memory:")));
const suite = testEffect(layer);
const openaiLiveIt = process.env.OPENAI_API_KEY ? suite.live : suite.live.skip;

const setup = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const { spaceId, location } = yield* seedSpace();
	const sessions = yield* Session.Service;
	const session = yield* sessions.create({
		spaceId,
		slug: `provider-${crypto.randomUUID()}`,
		directory: location,
		title: "Provider live test",
		tag: "test",
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
			const events = yield* Event.Service;
			/*
			 * One exchange in a fresh session. Whether a response carries a reasoning summary is the
			 * provider's call -- it can skip one for reasoning it judges trivial, whatever is asked --
			 * so that is not what this checks on its own. What the harness owes is that thinking is
			 * persisted exactly when thinking streamed, and that holds on every attempt.
			 */
			const attempt = Effect.gen(function* () {
				const { sql, sessions, sessionId } = yield* setup;
				const thinkingDeltas = yield* Ref.make(0);
				// Attempts run one after another and each removes its listener when its run ends, so
				// every delta counted here is this session's.
				const removeListener = yield* events.listen((event) =>
					event.type === "session.llm.thinking.delta"
						? Ref.update(thinkingDeltas, (count) => count + 1)
						: Effect.void,
				);
				const publisher = yield* LLMEventPublisher.make({ sessionId });
				const terminal = yield* LLM.run({
					sessionId,
					context: context(
						"Solve carefully, showing no work: how many positive integers below 1000 are divisible by 3 or 5 but not by 15? Reply with the number and one short verification sentence.",
					),
					provider: "openai",
					model: "gpt-5.6-luna",
					resolvedModel: yield* LLM.resolve({ provider: "openai", model: "gpt-5.6-luna" }),
					// Enough effort, and the fullest summary, to make one the usual answer.
					thinkingLevel: "medium",
					settings: { reasoningSummary: "detailed" },
					publisher,
				}).pipe(Effect.ensuring(removeListener));

				expect(terminal.outcome).toBe("ended");
				const path = yield* sessions.path(sessionId);
				expect(path.map((item) => item.entry.type)).toEqual(["assistant"]);
				const stored = yield* ContextCodec.decodeMessage(path[0]!);
				if (stored.role !== "assistant")
					return yield* Effect.die(`stored message is ${stored.role}, not assistant`);
				const streamed = (yield* Ref.get(thinkingDeltas)) > 0;
				const persisted = stored.parts.some((part) => part.type === "thinking" && part.thinking.trim().length > 0);
				expect(persisted).toBe(streamed);
				return { sql, sessionId, path, streamed } as const;
			});

			// A few fresh sessions until one response carries thinking, so the persistence path is
			// exercised rather than skipped when the provider happens to send none.
			let chosen = yield* attempt;
			for (let tries = 1; !chosen.streamed && tries < 3; tries++) chosen = yield* attempt;
			expect(chosen.streamed).toBe(true);

			const { sql, sessionId, path } = chosen;
			expect(path[0]!.entry.state).toBe("draft");
			expect(JSON.parse(path[0]!.entry.data)).toMatchObject({ stopReason: "stop" });
			expect(path[0]!.parts.some((part) => part.type === "thinking")).toBe(true);
			const durable = yield* sql`SELECT type FROM event WHERE aggregate_id = ${sessionId} ORDER BY seq`;
			expect(durable.map((row) => row.type)).toEqual(["session.llm.started.1", "session.llm.ended.1"]);
		}),
		{ timeout: 540_000 },
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
				model: "gpt-5.6-luna",
				resolvedModel: yield* LLM.resolve({ provider: "openai", model: "gpt-5.6-luna" }),
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
