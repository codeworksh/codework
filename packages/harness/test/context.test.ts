import { Message } from "@codeworksh/aikit";
import { DateTime, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { ContextCodec } from "../src/context/codec.ts";
import { HarnessContext } from "../src/context/context.ts";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { EventList } from "../src/event/list.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { AbsolutePath } from "../src/schema.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { SessionMessageSchema } from "../src/session/message/schema.ts";
import { SessionLive } from "../src/session/live.ts";
import { Session } from "../src/session/session.ts";
import { testEffect } from "./utils/effect.ts";

const sessionLayer = SessionLive.layer.pipe(
	Layer.provideMerge(Event.layer),
	Layer.provideMerge(Database.layer(":memory:")),
);
const layer = HarnessContext.layer.pipe(Layer.provideMerge(sessionLayer));
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
	yield* sql`INSERT OR IGNORE INTO project (id, name, created_at, updated_at) VALUES ('local','local',0,0)`;
	const sessions = yield* Session.Service;
	const created = yield* sessions.create({
		projectId: "local",
		slug: `context-${crypto.randomUUID()}`,
		directory: AbsolutePath.make("/repo"),
		title: "Context test",
		sandboxInstanceId: SandboxInstance.ID.local,
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
	return { append, appendMessage, context: yield* HarnessContext.Service, created, sessions, sql };
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

	it("rejects sparse indexes and mismatched promoted tool columns", () =>
		Effect.gen(function* () {
			const { appendMessage, sessions, sql } = yield* setup;
			const original = assistant("a_corrupt", "provider-a", "model-a", [
				{
					type: "toolCall",
					callID: "call_1",
					name: "read",
					arguments: {},
					status: "pending",
					time: { start: 1, end: 1 },
				},
			]);
			yield* appendMessage(original);
			yield* sql`UPDATE session_entry_part SET part_index = 1 WHERE entry_id = ${original.messageId}`;
			const sparse = Option.getOrThrow(yield* sessions.entry(original.messageId));
			const sparseError = yield* ContextCodec.decodeMessage(sparse).pipe(Effect.flip);
			expect(sparseError._tag).toBe("ContextDecodeError");
			expect(sparseError.reason).toContain("dense");

			yield* sql`
				UPDATE session_entry_part SET part_index = 0, call_id = 'call_other'
				WHERE entry_id = ${original.messageId}
			`;
			const mismatched = Option.getOrThrow(yield* sessions.entry(original.messageId));
			const mismatchError = yield* ContextCodec.decodeMessage(mismatched).pipe(Effect.flip);
			expect(mismatchError.reason).toContain("tool columns");
		}));
});

describe("context assembly", () => {
	it("projects Prompted directly as a canonical user message", () =>
		Effect.gen(function* () {
			const { context, created, sessions } = yield* setup;
			const events = yield* Event.Service;
			const messageId = SessionMessageSchema.ID.make("msg_native");
			const timestamp = yield* DateTime.now;

			yield* events.publish(EventList.Prompted, {
				sessionId: created.id,
				timestamp,
				messageId,
				prompt: { text: "native prompt" },
				delivery: "steer",
			});

			const stored = (yield* sessions.path(created.id))[0]!;
			expect(JSON.parse(stored.entry.data)).toEqual({
				messageId,
				role: "user",
				time: { created: DateTime.toEpochMillis(timestamp) },
			});
			expect(stored.parts).toHaveLength(1);
			expect(JSON.parse(stored.parts[0]!.data)).toEqual({ type: "text", text: "native prompt" });

			const snapshot = yield* context.assemble(created.id);
			expect(snapshot.messages).toMatchObject([
				{
					messageId,
					role: "user",
					parts: [{ type: "text", text: "native prompt" }],
				},
			]);
		}));

	it("distinguishes missing and empty sessions", () =>
		Effect.gen(function* () {
			const { context, created } = yield* setup;
			expect(yield* context.assemble(created.id)).toEqual({
				sessionId: created.id,
				leafEntryId: null,
				messages: [],
				config: {},
			});

			const missing = yield* context.assemble(SessionSchema.ID.make("ses_missing")).pipe(Effect.flip);
			expect(missing._tag).toBe("SessionNotFoundError");
		}));

	it("applies latest compaction while resolving config over the full path", () =>
		Effect.gen(function* () {
			const { append, appendMessage, context, created, sessions } = yield* setup;
			yield* appendMessage(user("u1", "old prompt"));
			yield* appendMessage(assistant("a1", "provider-1", "model-1"));
			yield* append({
				id: "config1",
				type: "configChange",
				data: JSON.stringify({
					model: { providerId: "configured", modelId: "configured-model" },
					thinkingLevel: "high",
				}),
			});
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
			yield* append({
				id: "config2",
				type: "configChange",
				data: JSON.stringify({ thinkingLevel: "low" }),
			});

			const snapshot = yield* context.assemble(created.id);
			expect(snapshot.leafEntryId).toBe("config2");
			expect(snapshot.config).toEqual({
				model: { providerId: "provider-2", modelId: "model-2" },
				thinkingLevel: "low",
			});
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

	it("fails typed when known entry data is malformed", () =>
		Effect.gen(function* () {
			const { append, context, created } = yield* setup;
			yield* append({ id: "bad-custom", type: "custom", data: "{}" });
			const failure = yield* context.assemble(created.id).pipe(Effect.flip);
			expect(failure._tag).toBe("ContextDecodeError");
			if (failure._tag === "ContextDecodeError") {
				expect(failure.entryId).toBe("bad-custom");
				expect(failure.type).toBe("custom");
			}
		}));

});
