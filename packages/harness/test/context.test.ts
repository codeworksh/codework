import { Message } from "@codeworksh/aikit";
import { DateTime, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { ContextCodec } from "../src/context/codec.ts";
import { Context } from "../src/context/context.ts";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { EventList } from "../src/event/list.ts";
import { seedSpace } from "./fixtures/space.ts";
import { SessionLive } from "../src/session/live.ts";
import { SessionMessageSchema } from "../src/session/message/schema.ts";
import { Session } from "../src/session/session.ts";
import { testEffect } from "./utils/effect.ts";

const sessionLayer = SessionLive.layer.pipe(
	Layer.provideMerge(Event.layer),
	Layer.provideMerge(Database.layer(":memory:")),
);
const layer = Context.layer.pipe(Layer.provideMerge(sessionLayer));
const { effect: it } = testEffect(layer);

const usage = (): Message.Usage => ({
	input: 1,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 10,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
});

const user = (id: string, text: string): Message.UserMessage =>
	Message.createUserMessage({
		messageId: id,
		role: "user",
		time: { created: 10 },
		parts: [{ type: "text", text }],
	});

const assistant = (
	id: string,
	providerId: string,
	model: string,
	parts: Message.AssistantMessage["parts"] = [{ type: "text", text: "ok" }],
): Message.AssistantMessage =>
	Message.createAssistantMessage({
		messageId: id,
		role: "assistant",
		protocol: "openai",
		provider: { id: providerId, name: providerId, source: "custom", env: [] },
		model,
		usage: usage(),
		stopReason: parts.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
		time: { created: 20, completed: 30 },
		parts,
	});

const setup = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const { spaceId, location } = yield* seedSpace();
	const sessions = yield* Session.Service;
	const created = yield* sessions.create({
		spaceId,
		slug: `context-${crypto.randomUUID()}`,
		directory: location,
		title: "Context test",
	});
	let seq = 0;
	const appendMessage = Effect.fnUntraced(function* (message: Message.Message) {
		const encoded = yield* ContextCodec.encodeMessage(message);
		seq += 1;
		yield* sessions.append({
			id: message.messageId,
			sessionId: created.id,
			seq,
			...encoded,
		});
	});
	const append = Effect.fnUntraced(function* (input: Omit<Session.AppendEntry, "sessionId" | "seq">) {
		seq += 1;
		yield* sessions.append({ ...input, sessionId: created.id, seq });
	});
	return { append, appendMessage, context: yield* Context.Service, created, sessions, sql };
});

describe("context codec", () => {
	it("round-trips complete messages and promotes tool-call columns", () =>
		Effect.gen(function* () {
			const { appendMessage, created, sessions } = yield* setup;
			const toolCall: Message.ToolCallPendingPart = {
				type: "toolCall",
				callID: "call_weather",
				name: "weather",
				arguments: { city: "Pune" },
				status: "pending",
				time: { start: 21, end: 21 },
			};
			const original = assistant("a_codec", "provider-a", "model-a", [
				{ type: "thinking", thinking: "checking" },
				toolCall,
			]);
			const encoded = yield* ContextCodec.encodeMessage(original);
			expect(encoded.data).not.toContain('"parts"');
			expect(encoded.parts[1]).toMatchObject({
				type: "toolCall",
				status: "pending",
				callId: "call_weather",
				toolName: "weather",
			});

			yield* appendMessage(original);
			const stored = Option.getOrThrow(yield* sessions.entry(original.messageId));
			expect(yield* ContextCodec.decodeMessage(stored)).toEqual(original);
			expect((yield* sessions.path(created.id)).at(-1)?.entry.id).toBe(original.messageId);
		}));
});

describe("context assembly", () => {
	it("omits draft and aborted assistants while retaining the raw tree leaf", () =>
		Effect.gen(function* () {
			const { appendMessage, context, created } = yield* setup;
			const events = yield* Event.Service;
			const assistantId = SessionMessageSchema.ID.make("msg_hidden_assistant");
			const message = assistant(assistantId, "provider-a", "model-a");
			yield* appendMessage(user("msg_visible_user", "hello"));

			yield* events.publish(EventList.LLMStarted, {
				sessionId: created.id,
				messageId: assistantId,
				timestamp: yield* DateTime.now,
				message,
			});
			const during = yield* context.assemble(created.id);
			expect(during.leafEntryId).toBe(assistantId);
			expect(during.messages.map((item) => item.messageId)).toEqual(["msg_visible_user"]);
			expect(during.lastAssistant).toBeUndefined();

			yield* events.publish(EventList.LLMFailed, {
				sessionId: created.id,
				messageId: assistantId,
				timestamp: yield* DateTime.now,
				reason: "aborted",
				message: { ...message, stopReason: "aborted", errorMessage: "interrupted", parts: [] },
			});
			const after = yield* context.assemble(created.id);
			expect(after.leafEntryId).toBe(assistantId);
			expect(after.messages.map((item) => item.messageId)).toEqual(["msg_visible_user"]);
			expect(after.lastAssistant).toBeUndefined();
		}));

	it("applies latest compaction over the full path", () =>
		Effect.gen(function* () {
			const { append, appendMessage, context, created, sessions } = yield* setup;
			yield* appendMessage(user("u1", "old prompt"));
			yield* appendMessage(assistant("a1", "provider-1", "model-1"));
			yield* appendMessage(user("u2", "kept prompt"));
			yield* append({
				id: "branch1",
				type: "branchSummary",
				data: JSON.stringify({ fromEntryId: "u1", summary: "The abandoned branch changed a test." }),
			});
			yield* append({
				id: "synthetic1",
				type: "synthetic",
				data: JSON.stringify({ messageId: "synthetic1", customType: "file", display: false }),
				parts: [{ type: "text", data: JSON.stringify({ type: "text", text: "file contents" }) }],
			});
			yield* append({
				id: "compact1",
				type: "compaction",
				data: JSON.stringify({ summary: "Earlier work was summarized.", firstKeptEntryId: "u2", tokensBefore: 50 }),
			});
			yield* append({ id: "custom1", type: "custom", data: JSON.stringify({ customType: "checkpoint" }) });
			yield* appendMessage(assistant("a2", "provider-2", "model-2", [{ type: "text", text: "new answer" }]));
			const snapshot = yield* context.assemble(created.id);
			expect(snapshot.leafEntryId).toBe("a2");
			expect(snapshot.lastAssistant).toMatchObject({ entryId: "a2", message: { messageId: "a2" } });
			expect(snapshot.messages.map((message) => message.messageId)).toEqual([
				"compact1",
				"u2",
				"branch1",
				"synthetic1",
				"a2",
			]);
			expect(snapshot.messages[0]?.parts[0]).toEqual({
				type: "text",
				text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nEarlier work was summarized.\n</summary>",
			});
			expect(snapshot.messages[2]?.parts[0]).toEqual({
				type: "text",
				text: "The following is a summary of a branch that this conversation came back from:\n\n<summary>\nThe abandoned branch changed a test.\n</summary>",
			});
			expect(snapshot.messages[3]?.parts[0]).toEqual({ type: "text", text: "file contents" });

			const path = yield* sessions.path(created.id);
			const compacted = path.find((item) => item.entry.id === "compact1");
			expect(snapshot.messages[0]?.time.created).toBe(
				compacted === undefined ? undefined : DateTime.toEpochMillis(compacted.entry.createdAt),
			);
		}));
});
