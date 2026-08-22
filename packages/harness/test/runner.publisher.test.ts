import type { Event as AikitEvent, Message } from "@codeworksh/aikit";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { LLMEventPublisher } from "../src/runner/event.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { AbsolutePath } from "../src/schema.ts";
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
	const sql = yield* SqlClient.SqlClient;
	yield* sql`INSERT OR IGNORE INTO project (id, name, created_at, updated_at) VALUES ('local','local',0,0)`;
	const sessions = yield* Session.Service;
	const session = yield* sessions.create({
		projectId: "local",
		slug: "pub",
		directory: AbsolutePath.make("/repo"),
		title: "T",
		tag: "test",
		sandboxInstanceId: SandboxInstance.ID.local,
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

/** The events a provider emits for a one-block text response. */
const textStream = (message: Message.AssistantMessage): ReadonlyArray<AikitEvent.LLMMessageEvent> => [
	{ type: "start", partial: message },
	{ type: "text.start", partIndex: 0, partial: message },
	{ type: "text.delta", partIndex: 0, delta: "hel", partial: message },
	{ type: "text.delta", partIndex: 0, delta: "lo", partial: message },
	{ type: "text.end", partIndex: 0, content: "hello", partial: message },
	{ type: "done", reason: "stop", message },
];

const storedEvents = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const rows = yield* sql`SELECT type FROM event ORDER BY seq`;
	return rows.map((row) => row.type as string);
});

describe("LLMEventPublisher", () => {
	it("inserts one draft at start and fills that same entry at the terminal", () =>
		Effect.gen(function* () {
			const { sessions, sessionId, publisher } = yield* setup;
			const message = assistant();

			yield* Effect.forEach(textStream(message), (event) => publisher.publish(event), { discard: true });

			// Start inserts the durable placeholder; deltas stay live; done fills it.
			expect(yield* storedEvents).toEqual(["session.llm.started.1", "session.llm.ended.1"]);

			const path = yield* sessions.path(sessionId);
			expect(path.map((item) => item.entry.id)).toEqual([messageId]);
			expect(path[0]!.entry.state).toBe("draft");
			expect(JSON.parse(path[0]!.parts[0]!.data)).toEqual({ type: "text", text: "hello" });

			const terminal = yield* publisher.terminal;
			expect(terminal.outcome).toBe("ended");
			expect(terminal.reason).toBe("stop");
		}));

	it("aborts the whole draft and discards text produced before the interrupt", () =>
		Effect.gen(function* () {
			const { sessions, sessionId, publisher } = yield* setup;
			const partial = assistant({ parts: [{ type: "text", text: "half" }] });

			yield* publisher.publish({ type: "start", partial });
			yield* publisher.publish({ type: "text.delta", partIndex: 0, delta: "half", partial });
			yield* publisher.publish({
				type: "error",
				reason: "aborted",
				error: assistant({
					stopReason: "aborted",
					errorMessage: "Request was aborted",
					parts: [{ type: "text", text: "half" }],
				}),
			});

			expect(yield* storedEvents).toEqual(["session.llm.started.1", "session.llm.failed.1"]);
			const path = yield* sessions.path(sessionId);
			expect(path[0]!.entry.state).toBe("aborted");
			expect(path[0]!.parts).toEqual([]);
			expect(JSON.parse(path[0]!.entry.data)).toMatchObject({ stopReason: "aborted" });

			const terminal = yield* publisher.terminal;
			expect(terminal.outcome).toBe("failed");
			expect(terminal.reason).toBe("aborted");
		}));

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

	it("rejects any event arriving after the terminal", () =>
		Effect.gen(function* () {
			const { publisher } = yield* setup;
			const message = assistant();
			yield* publisher.publish({ type: "start", partial: message });
			yield* publisher.publish({ type: "done", reason: "stop", message });

			const failure = yield* publisher
				.publish({ type: "text.delta", partIndex: 0, delta: "late", partial: message })
				.pipe(Effect.flip);

			expect(failure._tag).toBe("Runner.LLMStreamError");
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

	it("ignores tool-call events rather than failing the response", () =>
		Effect.gen(function* () {
			const { sessions, sessionId, publisher } = yield* setup;
			const message = assistant();
			const toolCall = {
				type: "toolCall",
				callID: "call_1",
				name: "bash",
				arguments: {},
				status: "pending",
				time: { start: 1, end: 1 },
			} as const satisfies Message.AssistantMessage["parts"][number];

			yield* publisher.publish({ type: "start", partial: message });
			yield* publisher.publish({ type: "toolcall.start", partIndex: 1, partial: message });
			yield* publisher.publish({ type: "toolcall.end", partIndex: 1, toolCall, partial: message });
			yield* publisher.publish({ type: "done", reason: "stop", message });

			expect(yield* storedEvents).toEqual(["session.llm.started.1", "session.llm.ended.1"]);
			expect((yield* sessions.path(sessionId)).length).toBe(1);
		}));

	it("delivers deltas to a live listener without persisting them", () =>
		Effect.gen(function* () {
			const { publisher } = yield* setup;
			const events = yield* Event.Service;
			const message = assistant();

			// `listen` registers synchronously, which is what a future streamer
			// hangs off. Deltas reach it and reach no table — the two halves of
			// "live only" asserted together.
			const seen: Array<{ type: string; delta: unknown }> = [];
			yield* events.listen((event) =>
				Effect.sync(() => {
					seen.push({ type: event.type, delta: (event.data as { delta?: unknown }).delta });
				}),
			);

			yield* publisher.publish({ type: "text.start", partIndex: 0, partial: message });
			yield* publisher.publish({ type: "text.delta", partIndex: 0, delta: "hel", partial: message });
			yield* publisher.publish({ type: "text.delta", partIndex: 0, delta: "lo", partial: message });

			expect(seen.map((item) => item.type)).toEqual([
				"session.llm.text.start",
				"session.llm.text.delta",
				"session.llm.text.delta",
			]);
			expect(seen.map((item) => item.delta)).toEqual([undefined, "hel", "lo"]);
			expect(yield* storedEvents).toEqual([]);
		}));

	it("stops delivering to a listener once it unsubscribes", () =>
		Effect.gen(function* () {
			const { publisher } = yield* setup;
			const events = yield* Event.Service;
			const message = assistant();

			const seen: string[] = [];
			const unsubscribe = yield* events.listen((event) => Effect.sync(() => seen.push(event.type)));
			yield* publisher.publish({ type: "text.delta", partIndex: 0, delta: "a", partial: message });
			yield* unsubscribe;
			yield* publisher.publish({ type: "text.delta", partIndex: 0, delta: "b", partial: message });

			expect(seen).toEqual(["session.llm.text.delta"]);
		}));

	it("gives each request its own latches", () =>
		Effect.gen(function* () {
			const { sessionId, publisher } = yield* setup;
			yield* publisher.publish({ type: "start", partial: assistant() });
			yield* publisher.publish({ type: "done", reason: "stop", message: assistant() });

			// A second request on the same session must not inherit the first's
			// terminal, which is why `make` is an Effect rather than a service.
			const second = yield* LLMEventPublisher.make({ sessionId });
			const failure = yield* second.terminal.pipe(Effect.flip);
			expect(failure.reason).toContain("without a terminal event");
		}));
});
