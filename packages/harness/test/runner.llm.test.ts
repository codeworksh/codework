import "./utils/env.ts";

import { createAssistantMessageEventStream, Message } from "@codeworksh/aikit";
import { Effect, Layer, Schema } from "effect";
import { describe, expect } from "vite-plus/test";
import * as Database from "../src/db/db.ts";
import * as Event from "../src/event/event.ts";
import * as EventList from "../src/event/list.ts";
import * as LLMEventPublisher from "../src/runner/event.ts";
import * as LLM from "../src/runner/llm.ts";
import { assistant } from "./fixtures/llm.ts";
import { seedSpace } from "./fixtures/space.ts";
import * as SessionLive from "../src/session/live.ts";
import * as Session from "../src/session/session.ts";
import { testEffect } from "./utils/effect.ts";

const layer = SessionLive.layer.pipe(Layer.provideMerge(Event.layer), Layer.provideMerge(Database.layer(":memory:")));
const { effect: it } = testEffect(layer);
const isTextDelta = Schema.is(EventList.LLMTextDelta);
const isThinkingDelta = Schema.is(EventList.LLMThinkingDelta);

const setup = Effect.gen(function* () {
	const { spaceId, location } = yield* seedSpace();
	const sessions = yield* Session.Service;
	const { session, thread } = yield* sessions.create({
		spaceId,
		directory: location,
		title: "Provider test",
		tag: "test",
	});
	return {
		events: yield* Event.Service,
		threadId: thread.id,
		publisher: yield* LLMEventPublisher.make({ sessionId: session.id, threadId: thread.id }),
	};
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
		"maps an async iterator failure to a typed ProviderError",
		Effect.gen(function* () {
			const { threadId, publisher } = yield* setup;
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
				threadId,
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
		"stamps each text and thinking delta with its part's length so far",
		Effect.gen(function* () {
			const { events, threadId, publisher } = yield* setup;
			// Thinking at 0, text at 1 and 2; 🌍 counts two in JS string length.
			const script = [
				{ kind: "thinking", partIndex: 0, deltas: ["Let", " me ", "think ✨"] },
				{ kind: "text", partIndex: 1, deltas: ["Hel", "lo 🌍", " world"] },
				{ kind: "text", partIndex: 2, deltas: ["", "Bye", "."] },
			] as const;
			const open: LLM.Open = (input) =>
				Effect.sync(() => {
					const message = assistant(input, 1, {
						parts: script.map((part) =>
							part.kind === "thinking"
								? { type: "thinking", thinking: part.deltas.join("") }
								: { type: "text", text: part.deltas.join("") },
						),
					});
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "start", partial: message });
					for (const { kind, partIndex, deltas } of script) {
						stream.push({ type: `${kind}.start`, partIndex, partial: message });
						for (const delta of deltas)
							stream.push({ type: `${kind}.delta`, partIndex, delta, partial: message });
						stream.push({ type: `${kind}.end`, partIndex, content: deltas.join(""), partial: message });
					}
					stream.push({ type: "done", reason: "stop", message });
					return stream;
				});

			const deltas: Array<{ type: string; partIndex: number; offset: number; delta: string }> = [];
			yield* events.listen((event) =>
				Effect.sync(() => {
					if (isTextDelta(event) || isThinkingDelta(event)) {
						const { partIndex, offset, delta } = event.data;
						deltas.push({ type: event.type, partIndex, offset, delta });
					}
				}),
			);
			yield* LLM.make(open)({
				threadId,
				context,
				provider: "openai",
				model: "gpt-4o-mini",
				resolvedModel: yield* LLM.resolve({ provider: "openai", model: "gpt-4o-mini" }),
				publisher,
			});

			const accumulated = new Map<number, number>();
			const artifact = deltas.map((item) => {
				const before = accumulated.get(item.partIndex) ?? 0;
				accumulated.set(item.partIndex, before + item.delta.length);
				return { ...item, accumulated: before, continues: item.offset === before };
			});
			expect(artifact.every((item) => item.continues)).toBe(true);
			yield* Effect.promise(() =>
				expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot(
					"./__artifacts__/runner.llm.deltas.json",
				),
			);
		}),
	);
});
