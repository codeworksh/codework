import "./utils/env.ts";

import { Message } from "@codeworksh/aikit";
import type { Model } from "@codeworksh/aikit";
import type { Protocol } from "@codeworksh/aikit";
import { llm, stream, Type, validateSchema } from "@codeworksh/aikit";
import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import path from "node:path";
import { beforeEach, describe, expect, it as vitestIt } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { AbsolutePath } from "../src/schema.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { Session } from "../src/session/session.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { tmpdir } from "./fixtures/tempdir.ts";
import { testEffect } from "./utils/effect.ts";

// Fresh in-memory database per test: the layer is rebuilt for every it.effect.
const layer = Session.layer.pipe(
	Layer.provideMerge(Event.layer),
	Layer.provideMerge(Database.layer(":memory:")),
);
const it = testEffect(layer);
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
const anthropicLiveIt = anthropicKey ? it.live : it.live.skip;
const openaiLiveIt = openaiKey ? it.live : it.live.skip;

// Fixture IDs stay readable; `ID.make` enforces the `ses` prefix.
const sid = (name: string) => SessionSchema.ID.make(`ses_${name}`);

// In production an entry's seq is the sequence of the event that produced it.
// These tests exercise the tree directly, with no event log behind them, so a
// per-session counter stands in. Dense here; sparse in production.
const seqCounters = new Map<string, number>();
const nextSeq = (sessionId: string) => {
	const next = (seqCounters.get(sessionId) ?? 0) + 1;
	seqCounters.set(sessionId, next);
	return next;
};
// A fork copies entry positions verbatim and seeds the new aggregate above
// them, so the stand-in counter has to continue from the source's position.
const inheritSeq = (sourceId: string, forkId: string) => {
	seqCounters.set(forkId, seqCounters.get(sourceId) ?? 0);
};
beforeEach(() => seqCounters.clear());

const createSession = (slug: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		// session.project_id references project(id)
		yield* sql`INSERT OR IGNORE INTO project (id, name, created_at, updated_at) VALUES ('local', 'local', 0, 0)`;

		const session = yield* Session.Service;
		return yield* session.create({
			projectId: "local",
			slug,
			directory: AbsolutePath.make("/repo"),
			title: "Test session",
			tag: "test",
			sandboxInstanceId: SandboxInstance.ID.local,
		});
	});

const userEntry = (sessionId: SessionSchema.ID, id: string, text: string): Session.AppendEntry => ({
	id,
	sessionId,
	seq: nextSeq(sessionId),
	type: "user",
	data: JSON.stringify({ messageId: id, role: "user", time: { created: 1 } }),
	parts: [{ type: "text", data: JSON.stringify({ type: "text", text }) }],
});

const usage = (
	input: Partial<Pick<SessionSchema.Usage, "input" | "output" | "cacheRead" | "cacheWrite">> & {
		readonly costTotal?: number;
	} = {},
): SessionSchema.Usage => {
	const tokens = {
		input: input.input ?? 0,
		output: input.output ?? 0,
		cacheRead: input.cacheRead ?? 0,
		cacheWrite: input.cacheWrite ?? 0,
	};
	return {
		...tokens,
		totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: input.costTotal ?? 0,
		},
	};
};

const assistantEntry = (
	sessionId: SessionSchema.ID,
	id: string,
	options?: { usage?: SessionSchema.Usage; toolCall?: { callId: string; toolName: string } },
): Session.AppendEntry => ({
	id,
	sessionId,
	seq: nextSeq(sessionId),
	type: "assistant",
	data: JSON.stringify({
		messageId: id,
		role: "assistant",
		stopReason: "stop",
		usage: options?.usage ?? usage(),
	}),
	parts: [
		{ type: "text", data: JSON.stringify({ type: "text", text: "ok" }) },
		...(options?.toolCall
			? [
					{
						type: "toolCall" as const,
						status: "pending" as const,
						callId: options.toolCall.callId,
						toolName: options.toolCall.toolName,
						data: JSON.stringify({
							type: "toolCall",
							callID: options.toolCall.callId,
							name: options.toolCall.toolName,
							status: "pending",
						}),
					},
				]
			: []),
	],
});

const countOf = (rows: ReadonlyArray<unknown>) => {
	const row = rows[0] as { count?: number | bigint } | undefined;
	return Number(row?.count ?? 0);
};

const appendMessage = (sessionId: SessionSchema.ID, message: Message.Message) => {
	const { parts, ...envelope } = message;
	return {
		id: message.messageId,
		sessionId,
		seq: nextSeq(sessionId),
		type: message.role,
		data: JSON.stringify(envelope),
		parts: parts.map((part) => ({
			type: part.type,
			status: part.type === "toolCall" ? part.status : undefined,
			callId: part.type === "toolCall" ? part.callID : undefined,
			toolName: part.type === "toolCall" ? part.name : undefined,
			data: JSON.stringify(part),
		})),
	} satisfies Session.AppendEntry;
};

const messageFromEntry = (hydrated: Session.HydratedEntry): Message.Message => {
	const message = {
		...(JSON.parse(hydrated.entry.data) as Record<string, unknown>),
		parts: hydrated.parts.map((part) => JSON.parse(part.data) as unknown),
	};
	return validateSchema(Message.MessageSchema, message, `session entry ${hydrated.entry.id}`);
};

const assistantText = (message: Message.AssistantMessage) =>
	message.parts
		.filter((part): part is Message.TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");

const usageTotals = (messages: ReadonlyArray<Message.AssistantMessage>) =>
	messages.reduce(
		(sum, message) => ({
			cost: sum.cost + message.usage.cost.total,
			input: sum.input + message.usage.input,
			output: sum.output + message.usage.output,
			cacheRead: sum.cacheRead + message.usage.cacheRead,
			cacheWrite: sum.cacheWrite + message.usage.cacheWrite,
		}),
		{ cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	);

const expectUsageTotals = (persisted: Session.SessionRow, totals: ReturnType<typeof usageTotals>) => {
	expect(persisted.cost).toBeCloseTo(totals.cost, 10);
	expect(persisted.tokensInput).toBe(totals.input);
	expect(persisted.tokensOutput).toBe(totals.output);
	expect(persisted.tokensCacheRead).toBe(totals.cacheRead);
	expect(persisted.tokensCacheWrite).toBe(totals.cacheWrite);
};

const weatherTool = Message.defineTool({
	name: "get_weather",
	description: "Get the current weather for a location.",
	parameters: Type.Object({
		location: Type.String({ description: "City or location to check" }),
	}),
});

const liveConversation = <TProtocol extends Protocol.ProtocolWithOptions>(
	model: Model.TModel<TProtocol>,
	options: Protocol.OptionsFor<TProtocol>,
	slug: string,
) =>
	Effect.gen(function* () {
		const session = yield* Session.Service;
		const created = yield* createSession(slug);
		const prompts = [
			"Remember the codeword COBALT-27. Reply with one short sentence confirming that you will remember it.",
			"What codeword did I ask you to remember? Reply with only the codeword.",
			"Also remember the second codeword AMBER-91. Reply with one short sentence confirming both codewords.",
			"Reply with both codewords in the order I gave them, separated by a comma and nothing else.",
		] as const;
		const assistantMessages: Message.AssistantMessage[] = [];
		for (const prompt of prompts) {
			const userMessage = Message.createUserMessage({
				role: "user",
				time: { created: Date.now() },
				parts: [{ type: "text", text: prompt }],
			});
			yield* session.append(appendMessage(created.id, userMessage));

			// The provider receives context reconstructed from SQLite, not the
			// in-memory messages accumulated by this test.
			const storedPath = yield* session.path(created.id);
			const context: Message.Context = {
				systemPrompt: "You are a concise assistant. Follow the user's requested response format.",
				messages: storedPath.map(messageFromEntry),
			};
			const assistant = yield* Effect.promise(() => stream.complete(model, context, options));
			expect(assistant.stopReason, assistant.errorMessage).not.toBe("error");
			expect(assistant.provider.id).toBe(model.provider.id);
			expect(assistant.model).toBe(model.id);
			expect(assistant.parts.length).toBeGreaterThan(0);
			expect(assistant.usage.input + assistant.usage.cacheRead).toBeGreaterThan(0);
			expect(assistant.usage.output).toBeGreaterThan(0);

			yield* session.append(appendMessage(created.id, assistant));
			assistantMessages.push(assistant);

			// Aggregates must be correct after every assistant transaction, not only
			// after the complete conversation is reloaded.
			const afterRound = Option.getOrElse(yield* session.get(created.id), () => created);
			expectUsageTotals(afterRound, usageTotals(assistantMessages));
		}

		const path = yield* session.path(created.id);
		const entryCount = prompts.length * 2;
		expect(path).toHaveLength(entryCount);
		expect(path.map((item) => item.entry.seq)).toEqual(Array.from({ length: entryCount }, (_, index) => index + 1));
		expect(path.map((item) => item.entry.type)).toEqual(prompts.flatMap(() => ["user", "assistant"] as const));
		expect(path.map((item) => Option.getOrNull(item.entry.parentId))).toEqual(
			path.map((_, index) => (index === 0 ? null : path[index - 1]!.entry.id)),
		);

		const messages = path.map(messageFromEntry);
		expect(messages.map((message) => message.messageId)).toEqual(path.map((item) => item.entry.id));
		const finalText = assistantText(messages.at(-1) as Message.AssistantMessage).toUpperCase();
		expect(finalText).toContain("COBALT-27");
		expect(finalText).toContain("AMBER-91");
		for (const item of path) {
			expect(JSON.parse(item.entry.data)).not.toHaveProperty("parts");
			expect(item.parts.length).toBeGreaterThan(0);
			for (const part of item.parts) {
				expect(JSON.parse(part.data).type).toBe(part.type);
			}
		}

		const totals = usageTotals(assistantMessages);
		const persisted = Option.getOrElse(yield* session.get(created.id), () => created);
		expectUsageTotals(persisted, totals);
		expect(Option.getOrNull(persisted.leafEntryId)).toBe(path.at(-1)!.entry.id);
	});

const liveToolConversation = <TProtocol extends Protocol.ProtocolWithOptions>(
	model: Model.TModel<TProtocol>,
	options: Protocol.OptionsFor<TProtocol>,
	slug: string,
) =>
	Effect.gen(function* () {
		const session = yield* Session.Service;
		const created = yield* createSession(slug);
		const userMessage = Message.createUserMessage({
			role: "user",
			time: { created: Date.now() },
			parts: [
				{
					type: "text",
					text: "Use get_weather exactly once to check Testville, then tell me the temperature and conditions.",
				},
			],
		});
		yield* session.append(appendMessage(created.id, userMessage));

		const toolRequestContext: Message.Context = {
			systemPrompt: "You are a concise assistant. Use the provided weather tool when asked.",
			messages: (yield* session.path(created.id)).map(messageFromEntry),
			tools: [weatherTool],
		};
		const toolRequest = yield* Effect.promise(() => stream.complete(model, toolRequestContext, options));
		expect(toolRequest.stopReason, toolRequest.errorMessage).not.toBe("error");
		const toolCalls = toolRequest.parts.filter(
			(part): part is Message.ToolCallPendingPart => part.type === "toolCall" && part.status === "pending",
		);
		expect(toolCalls).toHaveLength(1);
		const toolCall = toolCalls[0]!;
		expect(toolCall.name).toBe(weatherTool.name);
		expect(String(toolCall.arguments.location).toLowerCase()).toContain("testville");

		yield* session.append(appendMessage(created.id, toolRequest));
		const pending = yield* session.unsettled(created.id);
		expect(pending).toHaveLength(1);
		expect(Option.getOrNull(pending[0]!.callId)).toBe(toolCall.callID);
		expect(Option.getOrNull(pending[0]!.toolName)).toBe(weatherTool.name);
		expectUsageTotals(
			Option.getOrElse(yield* session.get(created.id), () => created),
			usageTotals([toolRequest]),
		);

		const completedToolCall: Message.ToolCallCompletedPart = {
			...toolCall,
			status: "completed",
			result: {
				content: [{ type: "text", text: "The current weather in Testville is 72 F and sunny." }],
				isError: false,
			},
			time: {
				start: toolCall.time.start,
				end: Date.now(),
			},
		};
		yield* session.settleToolCall({
			entryId: toolRequest.messageId,
			callId: toolCall.callID,
			status: "completed",
			data: JSON.stringify(completedToolCall),
		});
		expect(yield* session.unsettled(created.id)).toHaveLength(0);

		const settledEntry = Option.getOrElse(yield* session.entry(toolRequest.messageId), () => {
			throw new Error("settled assistant entry missing");
		});
		const settledMessage = messageFromEntry(settledEntry) as Message.AssistantMessage;
		const settledPart = settledMessage.parts.find(
			(part): part is Message.ToolCallCompletedPart => part.type === "toolCall" && part.status === "completed",
		);
		expect(settledPart?.callID).toBe(toolCall.callID);
		expect(settledPart?.result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("72 F") });

		const finalContext: Message.Context = {
			systemPrompt: toolRequestContext.systemPrompt,
			messages: (yield* session.path(created.id)).map(messageFromEntry),
			tools: [weatherTool],
		};
		const finalAssistant = yield* Effect.promise(() => stream.complete(model, finalContext, options));
		expect(finalAssistant.stopReason, finalAssistant.errorMessage).not.toBe("error");
		expect(finalAssistant.parts.some((part) => part.type === "toolCall")).toBe(false);
		const finalText = assistantText(finalAssistant).toLowerCase();
		expect(finalText).toContain("72");
		expect(finalText).toContain("sunny");
		yield* session.append(appendMessage(created.id, finalAssistant));

		const path = yield* session.path(created.id);
		expect(path.map((item) => item.entry.type)).toEqual(["user", "assistant", "assistant"]);
		expect(path.map((item) => item.entry.seq)).toEqual([1, 2, 3]);
		expect(path.map((item) => Option.getOrNull(item.entry.parentId))).toEqual([
			null,
			userMessage.messageId,
			toolRequest.messageId,
		]);
		expect(Option.getOrNull(Option.getOrElse(yield* session.get(created.id), () => created).leafEntryId)).toBe(
			finalAssistant.messageId,
		);
		expectUsageTotals(
			Option.getOrElse(yield* session.get(created.id), () => created),
			usageTotals([toolRequest, finalAssistant]),
		);
	});

describe("session", () => {
	it.effect("create + get round-trips the session row", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-create");

			const found = yield* session.get(created.id);
			expect(Option.isSome(found)).toBe(true);
			const row = Option.getOrElse(found, () => created);
			expect(row.slug).toBe("s-create");
			expect(row.cost).toBe(0);
			expect(row.tokensInput).toBe(0);
			expect(Option.isNone(row.leafEntryId)).toBe(true);

			const listed = yield* session.list({ projectId: "local" });
			expect(listed.map((r) => r.id)).toContain(created.id);
		}),
	);

	it.effect("append advances the leaf and produces dense seq", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-append");

			const first = yield* session.append(userEntry(created.id, "e1", "hello"));
			const second = yield* session.append(assistantEntry(created.id, "e2"));

			expect(first.seq).toBe(1);
			expect(second.seq).toBe(2);
			expect(Option.isNone(first.parentId)).toBe(true);
			expect(Option.getOrElse(second.parentId, () => "")).toBe("e1");

			const after = yield* session.get(created.id);
			const leaf = Option.flatMap(after, (row) => row.leafEntryId);
			expect(Option.getOrElse(leaf, () => "")).toBe("e2");
		}),
	);

	it.effect("append to a missing session fails typed", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const result = yield* session.append(userEntry(sid("nope"), "e1", "hi")).pipe(Effect.flip);
			expect(result._tag).toBe("SessionNotFoundError");
		}),
	);

	it.effect("assistant appends bump the session usage aggregates", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-usage");

			yield* session.append(userEntry(created.id, "e1", "hi"));
			yield* session.append(
				assistantEntry(created.id, "e2", {
					usage: usage({ input: 100, output: 20, cacheRead: 40, cacheWrite: 10, costTotal: 0.5 }),
				}),
			);
			yield* session.append(userEntry(created.id, "e3", "again"));
			yield* session.append(
				assistantEntry(created.id, "e4", {
					usage: usage({ input: 150, output: 30, cacheRead: 90, cacheWrite: 0, costTotal: 0.25 }),
				}),
			);

			const row = Option.getOrElse(yield* session.get(created.id), () => created);
			expect(row.tokensInput).toBe(250);
			expect(row.tokensOutput).toBe(50);
			expect(row.tokensCacheRead).toBe(130);
			expect(row.tokensCacheWrite).toBe(10);
			expect(row.cost).toBeCloseTo(0.75);
		}),
	);

	it.effect("path walks root→leaf across a branch point", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-branch");

			yield* session.append(userEntry(created.id, "e1", "start"));
			yield* session.append(assistantEntry(created.id, "e2"));
			yield* session.append(userEntry(created.id, "e3", "approach A"));
			yield* session.append(assistantEntry(created.id, "e4"));

			// abandon A: move the leaf back to e2 and take approach B
			yield* session.branch({ sessionId: created.id, entryId: "e2" });
			yield* session.append(userEntry(created.id, "e5", "approach B"));

			const path = yield* session.path(created.id);
			expect(path.map((h) => h.entry.id)).toEqual(["e1", "e2", "e5"]);

			// abandoned branch stays queryable on the full timeline
			const timeline = yield* session.timeline({ sessionId: created.id });
			expect(timeline.map((h) => h.entry.id)).toEqual(["e5", "e4", "e3", "e2", "e1"]);

			// e5 is a sibling of e3 (both children of e2)
			const e5 = timeline.find((h) => h.entry.id === "e5")!;
			expect(Option.getOrElse(e5.entry.parentId, () => "")).toBe("e2");
		}),
	);

	it.effect("branch to a foreign entry fails typed", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const a = yield* createSession("s-branch-a");
			const b = yield* createSession("s-branch-b");
			yield* session.append(userEntry(a.id, "e1", "hi"));

			const result = yield* session.branch({ sessionId: b.id, entryId: "e1" }).pipe(Effect.flip);
			expect(result._tag).toBe("EntryNotFoundError");
		}),
	);

	it.effect("timeline attaches parts only to message entries and pages by seq", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-timeline");

			yield* session.append(userEntry(created.id, "e1", "hi"));
			yield* session.append(assistantEntry(created.id, "e2"));
			yield* session.append({
				id: "e3",
				sessionId: created.id,
				seq: nextSeq(created.id),
				type: "compaction",
				data: JSON.stringify({ summary: "earlier work", firstKeptEntryId: "e1", tokensBefore: 1000 }),
			});

			const timeline = yield* session.timeline({ sessionId: created.id });
			const byId = new Map(timeline.map((h) => [h.entry.id, h]));
			expect(byId.get("e1")!.parts).toHaveLength(1);
			expect(byId.get("e2")!.parts).toHaveLength(1);
			expect(byId.get("e3")!.parts).toHaveLength(0);
			expect(byId.get("e1")!.parts[0]!.partIndex).toBe(0);

			// newest-first pagination: page of 2, then cursor
			const page1 = yield* session.timeline({ sessionId: created.id, limit: 2 });
			expect(page1.map((h) => h.entry.id)).toEqual(["e3", "e2"]);
			const cursor = page1[page1.length - 1]!.entry.seq;
			const page2 = yield* session.timeline({ sessionId: created.id, cursorSeq: cursor, limit: 2 });
			expect(page2.map((h) => h.entry.id)).toEqual(["e1"]);
		}),
	);

	it.effect("settleToolCall mutates exactly one part and drains unsettled", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-settle");

			yield* session.append(userEntry(created.id, "e1", "read a file"));
			yield* session.append(assistantEntry(created.id, "e2", { toolCall: { callId: "call_1", toolName: "read" } }));

			const pending = yield* session.unsettled(created.id);
			expect(pending).toHaveLength(1);
			expect(Option.getOrElse(pending[0]!.callId, () => "")).toBe("call_1");

			yield* session.settleToolCall({
				entryId: "e2",
				callId: "call_1",
				status: "completed",
				data: JSON.stringify({
					type: "toolCall",
					callID: "call_1",
					name: "read",
					status: "completed",
					result: { content: [{ type: "text", text: "{}" }], isError: false },
				}),
			});

			expect(yield* session.unsettled(created.id)).toHaveLength(0);

			const hydrated = Option.getOrElse(yield* session.entry("e2"), () => {
				throw new Error("entry missing");
			});
			const tool = hydrated.parts.find((p) => p.type === "toolCall")!;
			expect(Option.getOrElse(tool.status, () => "")).toBe("completed");
			expect(JSON.parse(tool.data).status).toBe("completed");
			// sibling text part untouched
			const text = hydrated.parts.find((p) => p.type === "text")!;
			expect(JSON.parse(text.data).text).toBe("ok");
		}),
	);

	it.effect("settleToolCall on an unknown call fails typed", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-settle-missing");
			yield* session.append(userEntry(created.id, "e1", "hi"));

			const result = yield* session
				.settleToolCall({ entryId: "e1", callId: "call_x", status: "error", data: "{}" })
				.pipe(Effect.flip);
			expect(result._tag).toBe("ToolCallNotFoundError");
		}),
	);

	it.effect("setLabel sets and clears the bookmark", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-label");
			yield* session.append(userEntry(created.id, "e1", "hi"));

			yield* session.setLabel({ sessionId: created.id, entryId: "e1", label: "important" });
			let hydrated = yield* session.entry("e1");
			expect(Option.flatMap(hydrated, (h) => h.entry.label).pipe(Option.getOrElse(() => ""))).toBe("important");

			yield* session.setLabel({ sessionId: created.id, entryId: "e1", label: null });
			hydrated = yield* session.entry("e1");
			expect(Option.isNone(Option.flatMap(hydrated, (h) => h.entry.label))).toBe(true);
		}),
	);

	it.effect("append validates an explicit parentId against the session", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const a = yield* createSession("s-parent-a");
			const b = yield* createSession("s-parent-b");
			yield* session.append(userEntry(a.id, "ea1", "in session a"));
			yield* session.append(userEntry(b.id, "eb1", "in session b"));

			// cross-session parent is rejected typed
			const result = yield* session
				.append({ ...userEntry(b.id, "eb2", "bad parent"), parentId: "ea1" })
				.pipe(Effect.flip);
			expect(result._tag).toBe("EntryNotFoundError");

			// same-session explicit parent works (sibling branch append)
			const sibling = yield* session.append({ ...userEntry(b.id, "eb3", "good parent"), parentId: "eb1" });
			expect(Option.getOrElse(sibling.parentId, () => "")).toBe("eb1");
		}),
	);

	it.effect("append falls back to the latest entry when the leaf pointer is lost", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const session = yield* Session.Service;
			const created = yield* createSession("s-leaf-lost");
			yield* session.append(userEntry(created.id, "e1", "hi"));
			yield* session.append(assistantEntry(created.id, "e2"));

			// simulate imported/recovered state: entries exist, cursor lost
			yield* sql`UPDATE session SET leaf_entry_id = NULL WHERE id = ${created.id}`;

			const third = yield* session.append(userEntry(created.id, "e3", "resume"));
			expect(Option.getOrElse(third.parentId, () => "")).toBe("e2");

			const path = yield* session.path(created.id);
			expect(path.map((h) => h.entry.id)).toEqual(["e1", "e2", "e3"]);
		}),
	);

	it.effect("duplicate call ids within an entry are rejected by the schema", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-dup-call");

			const toolPart = (callId: string): Session.AppendPart => ({
				type: "toolCall",
				status: "pending",
				callId,
				toolName: "read",
				data: JSON.stringify({ type: "toolCall", callID: callId, name: "read", status: "pending" }),
			});

			const exit = yield* session
				.append({
					...assistantEntry(created.id, "e1"),
					parts: [toolPart("call_dup"), toolPart("call_dup")],
				})
				.pipe(Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);

			// the failed transaction rolled back whole — no partial entry
			expect(Option.isNone(yield* session.entry("e1"))).toBe(true);
		}),
	);

	it.effect("assistant usage must come from the stored envelope", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-usage-guard");

			const error = yield* session
				.append({
					...assistantEntry(created.id, "e1"),
					data: JSON.stringify({ messageId: "e1", role: "assistant", stopReason: "stop" }),
				})
				.pipe(Effect.flip);
			expect(error._tag).toBe("InvalidEntryDataError");

			// nothing was written
			expect(Option.isNone(yield* session.entry("e1"))).toBe(true);
			const row = Option.getOrElse(yield* session.get(created.id), () => created);
			expect(row.cost).toBe(0);
		}),
	);

	// Part data is read back with a bare JSON.parse by everything downstream, so
	// an unparseable part has to be rejected at the write rather than discovered
	// by whichever reader hits it first.
	it.effect("append rejects a part whose data is not a JSON object", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-part-json-guard");

			for (const data of ["not json", "[]", '"just a string"']) {
				const failure = yield* session
					.append({
						...userEntry(created.id, `bad-part-${data.length}`, "hi"),
						parts: [{ type: "text", data }],
					})
					.pipe(Effect.flip);
				expect(failure._tag).toBe("InvalidEntryDataError");
			}

			// Nothing was written by any of them.
			expect(yield* session.path(created.id)).toEqual([]);
		}),
	);

	it.effect("append rejects malformed and mismatched message envelopes before writing", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-envelope-identity-guard");
			const invalidEntries: ReadonlyArray<Session.AppendEntry> = [
				{ id: "bad-json", sessionId: created.id, seq: nextSeq(created.id), type: "user", data: "not json" },
				{ id: "bad-array", sessionId: created.id, seq: nextSeq(created.id), type: "user", data: "[]" },
				{ id: "missing-id", sessionId: created.id, seq: nextSeq(created.id), type: "synthetic", data: JSON.stringify({ customType: "x" }) },
				{
					...assistantEntry(created.id, "mismatched-id"),
					data: JSON.stringify({
						messageId: "different-id",
						role: "assistant",
						stopReason: "stop",
						usage: usage(),
					}),
				},
			];

			for (const input of invalidEntries) {
				const error = yield* session.append(input).pipe(Effect.flip);
				expect(error._tag).toBe("InvalidEntryDataError");
				expect(Option.isNone(yield* session.entry(input.id))).toBe(true);
			}

			const persisted = Option.getOrElse(yield* session.get(created.id), () => created);
			expect(Option.isNone(persisted.leafEntryId)).toBe(true);
			expect(yield* session.timeline({ sessionId: created.id })).toHaveLength(0);
		}),
	);

	it.effect("append validates compaction shape and boundary against its actual parent path", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const source = yield* createSession("s-compaction-guard");
			const other = yield* createSession("s-compaction-guard-other");
			yield* session.append(userEntry(source.id, "e1", "root"));
			yield* session.append(assistantEntry(source.id, "e2"));
			yield* session.branch({ sessionId: source.id, entryId: "e1" });
			yield* session.append(userEntry(source.id, "e3", "active sibling"));
			yield* session.append(userEntry(other.id, "other-e1", "foreign"));

			const invalidCompactions: ReadonlyArray<Session.AppendEntry> = [
				{
					id: "c-missing-boundary",
					sessionId: source.id,
					seq: nextSeq(source.id),
					type: "compaction",
					data: JSON.stringify({ summary: "missing", tokensBefore: 10 }),
				},
				{
					id: "c-negative-tokens",
					sessionId: source.id,
					seq: nextSeq(source.id),
					type: "compaction",
					data: JSON.stringify({ summary: "negative", firstKeptEntryId: null, tokensBefore: -1 }),
				},
				{
					id: "c-abandoned-boundary",
					sessionId: source.id,
					seq: nextSeq(source.id),
					type: "compaction",
					data: JSON.stringify({ summary: "abandoned", firstKeptEntryId: "e2", tokensBefore: 10 }),
				},
				{
					id: "c-foreign-boundary",
					sessionId: source.id,
					seq: nextSeq(source.id),
					type: "compaction",
					data: JSON.stringify({ summary: "foreign", firstKeptEntryId: "other-e1", tokensBefore: 10 }),
				},
			];

			for (const input of invalidCompactions) {
				const error = yield* session.append(input).pipe(Effect.flip);
				expect(error._tag).toBe("InvalidEntryDataError");
				expect(Option.isNone(yield* session.entry(input.id))).toBe(true);
			}
			const afterInvalid = Option.getOrElse(yield* session.get(source.id), () => source);
			expect(Option.getOrElse(afterInvalid.leafEntryId, () => "")).toBe("e3");
			expect(yield* session.timeline({ sessionId: source.id })).toHaveLength(3);

			// The explicit parent, not the current leaf, defines the compaction path.
			const anchored = yield* session.append({
				id: "c-anchored",
				sessionId: source.id,
				seq: nextSeq(source.id),
				parentId: "e2",
				type: "compaction",
				data: JSON.stringify({ summary: "root work", firstKeptEntryId: "e1", tokensBefore: 10 }),
			});
			expect(Option.getOrElse(anchored.parentId, () => "")).toBe("e2");

			const wrongAnchor = yield* session
				.append({
					id: "c-wrong-anchor",
					sessionId: source.id,
					seq: nextSeq(source.id),
					parentId: "e2",
					type: "compaction",
					data: JSON.stringify({ summary: "wrong path", firstKeptEntryId: "e3", tokensBefore: 10 }),
				})
				.pipe(Effect.flip);
			expect(wrongAnchor._tag).toBe("InvalidEntryDataError");
			expect(Option.isNone(yield* session.entry("c-wrong-anchor"))).toBe(true);
			const afterWrongAnchor = Option.getOrElse(yield* session.get(source.id), () => source);
			expect(Option.getOrElse(afterWrongAnchor.leafEntryId, () => "")).toBe("c-anchored");

			const summaryOnly = yield* session.append({
				id: "c-summary-only",
				sessionId: source.id,
				seq: nextSeq(source.id),
				type: "compaction",
				data: JSON.stringify({ summary: "all prior work", firstKeptEntryId: null, tokensBefore: 10 }),
			});
			expect(JSON.parse(summaryOnly.data).firstKeptEntryId).toBeNull();
		}),
	);

	it.effect("non-message entries reject parts with a typed error", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const created = yield* createSession("s-parts-guard");

			const error = yield* session
				.append({
					id: "e1",
					sessionId: created.id,
					seq: nextSeq(created.id),
					type: "compaction",
					data: JSON.stringify({ summary: "s", firstKeptEntryId: null, tokensBefore: 10 }),
					parts: [{ type: "text", data: JSON.stringify({ type: "text", text: "x" }) }],
				})
				.pipe(Effect.flip);
			expect(error._tag).toBe("InvalidEntryDataError");
			expect(Option.isNone(yield* session.entry("e1"))).toBe(true);
		}),
	);

	it.effect("schema rejects cross-session parent edges", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const session = yield* Session.Service;
			const a = yield* createSession("s-fk-parent-a");
			const b = yield* createSession("s-fk-parent-b");
			yield* session.append(userEntry(a.id, "ea1", "in session a"));
			yield* session.append(userEntry(b.id, "eb1", "in session b"));

			const exit = yield* sql`
				INSERT INTO session_entry (id, session_id, parent_id, seq, type, data, created_at, updated_at)
				VALUES ('eb_bad', ${b.id}, 'ea1', 2, 'user', '{}', 0, 0)
			`.pipe(Effect.exit);

			expect(Exit.isFailure(exit)).toBe(true);
			expect(Option.isNone(yield* session.entry("eb_bad"))).toBe(true);
		}),
	);

	it.effect("schema rejects parts whose session does not own the entry", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const session = yield* Session.Service;
			const a = yield* createSession("s-fk-part-a");
			const b = yield* createSession("s-fk-part-b");
			yield* session.append(userEntry(a.id, "ea1", "in session a"));

			const exit = yield* sql`
				INSERT INTO session_entry_part
					(id, entry_id, session_id, part_index, type, data, created_at, updated_at)
				VALUES ('p_bad', 'ea1', ${b.id}, 0, 'text', '{}', 0, 0)
			`.pipe(Effect.exit);

			expect(Exit.isFailure(exit)).toBe(true);
			const rows = yield* sql`SELECT count(*) AS count FROM session_entry_part WHERE id = 'p_bad'`;
			expect(countOf(rows)).toBe(0);
		}),
	);

	it.effect("schema enforces toolCall promoted-column shape", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const session = yield* Session.Service;
			const created = yield* createSession("s-check-tool-shape");
			yield* session.append(assistantEntry(created.id, "e1"));

			const nonToolWithStatus = yield* sql`
				INSERT INTO session_entry_part
					(id, entry_id, session_id, part_index, type, status, data, created_at, updated_at)
				VALUES ('p_text_bad', 'e1', ${created.id}, 10, 'text', 'pending', '{}', 0, 0)
			`.pipe(Effect.exit);

			const toolMissingCall = yield* sql`
				INSERT INTO session_entry_part
					(id, entry_id, session_id, part_index, type, status, tool_name, data, created_at, updated_at)
				VALUES ('p_tool_bad', 'e1', ${created.id}, 11, 'toolCall', 'pending', 'read', '{}', 0, 0)
			`.pipe(Effect.exit);

			expect(Exit.isFailure(nonToolWithStatus)).toBe(true);
			expect(Exit.isFailure(toolMissingCall)).toBe(true);
			const rows = yield* sql`
				SELECT count(*) AS count FROM session_entry_part WHERE id IN ('p_text_bad', 'p_tool_bad')
			`;
			expect(countOf(rows)).toBe(0);
		}),
	);

	it.effect("schema cascades whole-session deletes through entries and parts", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const session = yield* Session.Service;
			const created = yield* createSession("s-cascade");
			yield* session.append(userEntry(created.id, "e1", "hi"));
			yield* session.append(assistantEntry(created.id, "e2", { toolCall: { callId: "call_1", toolName: "read" } }));

			yield* sql`DELETE FROM session WHERE id = ${created.id}`;

			const entries = yield* sql`SELECT count(*) AS count FROM session_entry WHERE session_id = ${created.id}`;
			const parts = yield* sql`SELECT count(*) AS count FROM session_entry_part WHERE session_id = ${created.id}`;
			expect(countOf(entries)).toBe(0);
			expect(countOf(parts)).toBe(0);
		}),
	);

	it.effect("migration creates the session-entry tables and indexes", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const rows = yield* sql`
				SELECT name FROM sqlite_master
				WHERE type IN ('table', 'index')
					AND name IN (
						'session_entry',
						'session_entry_part',
						'session_entry_session_id_idx',
						'session_entry_session_seq_idx',
						'session_entry_parent_idx',
						'session_entry_type_idx',
						'session_entry_label_idx',
						'session_entry_part_entry_idx',
						'session_entry_part_call_idx',
						'session_entry_part_call_uidx',
						'session_entry_part_unsettled_idx',
						'session_entry_part_session_idx'
					)
			`;
			const names = new Set(rows.map((row) => (row as { name: string }).name));
			expect(names).toEqual(
				new Set([
					"session_entry",
					"session_entry_part",
					"session_entry_session_id_idx",
					"session_entry_session_seq_idx",
					"session_entry_parent_idx",
					"session_entry_type_idx",
					"session_entry_label_idx",
					"session_entry_part_entry_idx",
					"session_entry_part_call_idx",
					"session_entry_part_call_uidx",
					"session_entry_part_unsettled_idx",
					"session_entry_part_session_idx",
				]),
			);
		}),
	);

	it.effect("failed DB constraint inside append-like transaction rolls back the entry", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const created = yield* createSession("s-rollback-check");

			const exit = yield* sql
				.withTransaction(
					Effect.gen(function* () {
						yield* sql`
							INSERT INTO session_entry (id, session_id, parent_id, seq, type, data, created_at, updated_at)
							VALUES ('e_bad', ${created.id}, NULL, 1, 'assistant', '{}', 0, 0)
						`;
						yield* sql`
							INSERT INTO session_entry_part
								(id, entry_id, session_id, part_index, type, status, data, created_at, updated_at)
							VALUES ('p_bad', 'e_bad', ${created.id}, 0, 'text', 'pending', '{}', 0, 0)
						`;
					}),
				)
				.pipe(Effect.exit);

			expect(Exit.isFailure(exit)).toBe(true);
			const entries = yield* sql`SELECT count(*) AS count FROM session_entry WHERE id = 'e_bad'`;
			const parts = yield* sql`SELECT count(*) AS count FROM session_entry_part WHERE id = 'p_bad'`;
			expect(countOf(entries)).toBe(0);
			expect(countOf(parts)).toBe(0);
		}),
	);

	it.effect("clone (fork at leaf) copies the path with fresh identity", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const source = yield* createSession("s-fork-clone-src");
			yield* session.append(userEntry(source.id, "e1", "hello"));
			yield* session.append(assistantEntry(source.id, "e2", { toolCall: { callId: "call_1", toolName: "read" } }));
			yield* session.setLabel({ sessionId: source.id, entryId: "e1", label: "start" });

			const fork = yield* session.fork({ sessionId: source.id, slug: "s-fork-clone" });

			// lineage + fresh session state
			expect(Option.getOrElse(fork.parentId, () => "")).toBe(source.id);
			expect(fork.cost).toBe(0);
			expect(fork.title).toBe(source.title);

			const forkPath = yield* session.path(fork.id);
			const sourcePath = yield* session.path(source.id);
			expect(forkPath.map((h) => h.entry.type)).toEqual(sourcePath.map((h) => h.entry.type));
			// all new entry ids, dense seq, envelope messageId rewritten to the new id
			for (const [i, hydrated] of forkPath.entries()) {
				expect(hydrated.entry.id).not.toBe(sourcePath[i]!.entry.id);
				expect(hydrated.entry.seq).toBe(i + 1);
				expect(JSON.parse(hydrated.entry.data).messageId).toBe(hydrated.entry.id);
			}
			// parts copied verbatim with preserved partIndex; label rode along
			const forkAssistant = forkPath[1]!;
			expect(forkAssistant.parts.map((p) => p.partIndex)).toEqual([0, 1]);
			expect(Option.getOrElse(forkAssistant.parts[1]!.callId, () => "")).toBe("call_1");
			expect(Option.getOrElse(forkPath[0]!.entry.label, () => "")).toBe("start");
			// pending toolCall copied as pending → fork inherits recovery
			expect(yield* session.unsettled(fork.id)).toHaveLength(1);

			// source untouched
			const sourceAfter = Option.getOrElse(yield* session.get(source.id), () => source);
			expect(Option.getOrElse(sourceAfter.leafEntryId, () => "")).toBe("e2");
			expect((yield* session.timeline({ sessionId: source.id })).length).toBe(2);
		}),
	);

	it.effect("fork copies only the active path, not abandoned branches", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const source = yield* createSession("s-fork-branches-src");
			yield* session.append(userEntry(source.id, "e1", "start"));
			yield* session.append(assistantEntry(source.id, "e2"));
			yield* session.append(userEntry(source.id, "e3", "approach A"));
			yield* session.branch({ sessionId: source.id, entryId: "e2" });
			yield* session.append(userEntry(source.id, "e5", "approach B"));

			const fork = yield* session.fork({ sessionId: source.id, slug: "s-fork-branches" });

			// source has 4 entries; fork has only the active path e1→e2→e5
			const forkTimeline = yield* session.timeline({ sessionId: fork.id });
			expect(forkTimeline).toHaveLength(3);
			const forkPath = yield* session.path(fork.id);
			expect(forkPath.map((h) => JSON.parse(h.entry.data).messageId ?? h.entry.id)).toEqual(
				forkPath.map((h) => h.entry.id),
			);
			// fork diverges independently of the source
			inheritSeq(source.id, fork.id);
			yield* session.append(userEntry(fork.id, "f6", "fork continues"));
			expect((yield* session.timeline({ sessionId: source.id })).length).toBe(4);
			expect((yield* session.timeline({ sessionId: fork.id })).length).toBe(4);
		}),
	);

	it.effect("fork remaps compaction firstKeptEntryId into the new session", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const source = yield* createSession("s-fork-compaction-src");
			yield* session.append(userEntry(source.id, "e1", "old"));
			yield* session.append(assistantEntry(source.id, "e2"));
			yield* session.append({
				id: "c3",
				sessionId: source.id,
				seq: nextSeq(source.id),
				type: "compaction",
				data: JSON.stringify({ summary: "earlier work", firstKeptEntryId: "e2", tokensBefore: 1000 }),
			});
			yield* session.append(userEntry(source.id, "e4", "after compaction"));
			yield* session.append({
				id: "c5",
				sessionId: source.id,
				seq: nextSeq(source.id),
				type: "compaction",
				data: JSON.stringify({ summary: "all prior work", firstKeptEntryId: null, tokensBefore: 500 }),
			});

			const fork = yield* session.fork({ sessionId: source.id, slug: "s-fork-compaction" });
			const forkPath = yield* session.path(fork.id);

			const forkE2 = forkPath[1]!.entry; // copy of e2
			const forkCompaction = forkPath[2]!.entry;
			const forkSummaryOnly = forkPath[4]!.entry;
			expect(forkCompaction.type).toBe("compaction");
			const payload = JSON.parse(forkCompaction.data);
			// window pointer follows the copy — not the old session's id
			expect(payload.firstKeptEntryId).toBe(forkE2.id);
			expect(payload.firstKeptEntryId).not.toBe("e2");
			expect(payload.summary).toBe("earlier work");
			expect(JSON.parse(forkSummaryOnly.data).firstKeptEntryId).toBeNull();
		}),
	);

	it.effect("fork rejects malformed legacy envelopes without committing a partial destination", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const session = yield* Session.Service;
			const source = yield* createSession("s-fork-legacy-envelope-src");
			yield* session.append(userEntry(source.id, "e1", "valid prefix"));
			yield* sql`
				INSERT INTO session_entry (id, session_id, parent_id, seq, type, data, created_at, updated_at)
				VALUES ('legacy-array', ${source.id}, 'e1', 2, 'user', '[]', 0, 0)
			`;
			yield* sql`UPDATE session SET leaf_entry_id = 'legacy-array' WHERE id = ${source.id}`;

			const error = yield* session
				.fork({
					sessionId: source.id,
					id: sid("s-fork-legacy-envelope-dest"),
					slug: "s-fork-legacy-envelope-dest",
				})
				.pipe(Effect.flip);
			expect(error._tag).toBe("InvalidEntryDataError");
			expect(Option.isNone(yield* session.get(sid("s-fork-legacy-envelope-dest")))).toBe(true);
			expect(yield* session.timeline({ sessionId: source.id })).toHaveLength(2);
		}),
	);

	it.effect("fork rejects an unmappable legacy compaction boundary atomically", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const session = yield* Session.Service;
			const source = yield* createSession("s-fork-legacy-compaction-src");
			yield* session.append(userEntry(source.id, "e1", "valid prefix"));
			const corruptData = JSON.stringify({
				summary: "corrupt boundary",
				firstKeptEntryId: "not-on-path",
				tokensBefore: 10,
			});
			yield* sql`
				INSERT INTO session_entry (id, session_id, parent_id, seq, type, data, created_at, updated_at)
				VALUES ('legacy-compaction', ${source.id}, 'e1', 2, 'compaction', ${corruptData}, 0, 0)
			`;
			yield* sql`UPDATE session SET leaf_entry_id = 'legacy-compaction' WHERE id = ${source.id}`;

			const error = yield* session
				.fork({
					sessionId: source.id,
					id: sid("s-fork-legacy-compaction-dest"),
					slug: "s-fork-legacy-compaction-dest",
				})
				.pipe(Effect.flip);
			expect(error._tag).toBe("InvalidEntryDataError");
			if (error._tag === "InvalidEntryDataError") {
				expect(error.reason).toContain("not on the copied path");
			}
			expect(Option.isNone(yield* session.get(sid("s-fork-legacy-compaction-dest")))).toBe(true);
			expect(yield* session.timeline({ sessionId: source.id })).toHaveLength(2);
		}),
	);

	it.effect("forkBefore a user entry lands at its parent; validates entry type", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const source = yield* createSession("s-fork-before-src");
			yield* session.append(userEntry(source.id, "e1", "keep me"));
			yield* session.append(assistantEntry(source.id, "e2"));
			yield* session.append(userEntry(source.id, "e3", "redo this prompt"));

			// before e3 → fork contains e1, e2; leaf = copy of e2
			const fork = yield* session.fork({
				sessionId: source.id,
				entryId: "e3",
				mode: "before",
				slug: "s-fork-before",
			});
			const forkPath = yield* session.path(fork.id);
			expect(forkPath).toHaveLength(2);
			expect(forkPath.map((h) => h.entry.type)).toEqual(["user", "assistant"]);

			// before a non-user entry is a typed structural rejection
			const invalid = yield* session
				.fork({ sessionId: source.id, entryId: "e2", mode: "before", slug: "s-fork-before-bad" })
				.pipe(Effect.flip);
			expect(invalid._tag).toBe("InvalidEntryDataError");

			// before the root user entry → empty fork
			const empty = yield* session.fork({
				sessionId: source.id,
				entryId: "e1",
				mode: "before",
				slug: "s-fork-before-empty",
			});
			expect(Option.isNone(empty.leafEntryId)).toBe(true);
			expect(yield* session.path(empty.id)).toHaveLength(0);
		}),
	);

	it.effect("fork validates the fork point against the source session", () =>
		Effect.gen(function* () {
			const session = yield* Session.Service;
			const a = yield* createSession("s-fork-val-a");
			const b = yield* createSession("s-fork-val-b");
			yield* session.append(userEntry(a.id, "ea1", "in a"));

			const foreign = yield* session
				.fork({ sessionId: b.id, entryId: "ea1", slug: "s-fork-val-bad" })
				.pipe(Effect.flip);
			expect(foreign._tag).toBe("EntryNotFoundError");

			const missing = yield* session.fork({ sessionId: sid("nope"), slug: "s-fork-val-missing" }).pipe(Effect.flip);
			expect(missing._tag).toBe("SessionNotFoundError");
		}),
	);

	vitestIt("persists session entries across a file database reload", async () => {
		await using tmp = await tmpdir();
		const database = path.join(tmp.path, "session.db");
		const fileLayer = Session.layer.pipe(
			Layer.provideMerge(Event.layer),
			Layer.provideMerge(Database.layer(database)),
		);

		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT OR IGNORE INTO project (id, name, created_at, updated_at) VALUES ('local', 'local', 0, 0)`;

				const session = yield* Session.Service;
				yield* session.create({
					id: sid("persisted-session"),
					projectId: "local",
					slug: "s-file-reload",
					directory: AbsolutePath.make("/repo"),
					title: "Persisted session",
					tag: "test",
					sandboxInstanceId: SandboxInstance.ID.local,
				});
				yield* session.append(userEntry(sid("persisted-session"), "e1", "hello"));
				yield* session.append(assistantEntry(sid("persisted-session"), "e2"));
			}).pipe(Effect.scoped, Effect.provide(fileLayer)),
		);

		const ids = await Effect.runPromise(
			Effect.gen(function* () {
				const session = yield* Session.Service;
				const path = yield* session.path(sid("persisted-session"));
				return path.map((entry) => entry.entry.id);
			}).pipe(Effect.scoped, Effect.provide(fileLayer)),
		);

		expect(ids).toEqual(["e1", "e2"]);
	});

	anthropicLiveIt(
		"persists a real four-round Anthropic conversation",
		() =>
			Effect.gen(function* () {
				const model = yield* Effect.promise(() => llm("anthropic", "claude-haiku-4-5-20251001"));
				if (!model) return yield* Effect.die(new Error("aikit did not resolve the Anthropic test model"));
				yield* liveConversation(
					model,
					{ apiKey: anthropicKey, maxTokens: 96, temperature: 0, maxRetries: 1 },
					"s-live-anthropic",
				);
			}),
		{ timeout: 120_000 },
	);

	openaiLiveIt(
		"persists a real four-round OpenAI conversation",
		() =>
			Effect.gen(function* () {
				const model = yield* Effect.promise(() => llm("openai", "gpt-4o-mini"));
				if (!model) return yield* Effect.die(new Error("aikit did not resolve the OpenAI test model"));
				yield* liveConversation(
					model,
					{ apiKey: openaiKey, maxTokens: 96, temperature: 0, maxRetries: 1 },
					"s-live-openai",
				);
			}),
		{ timeout: 120_000 },
	);

	anthropicLiveIt(
		"persists and settles a real Anthropic weather tool call",
		() =>
			Effect.gen(function* () {
				const model = yield* Effect.promise(() => llm("anthropic", "claude-haiku-4-5-20251001"));
				if (!model) return yield* Effect.die(new Error("aikit did not resolve the Anthropic test model"));
				yield* liveToolConversation(
					model,
					{ apiKey: anthropicKey, maxTokens: 128, temperature: 0, maxRetries: 1 },
					"s-live-tool-anthropic",
				);
			}),
		{ timeout: 120_000 },
	);

	openaiLiveIt(
		"persists and settles a real OpenAI weather tool call",
		() =>
			Effect.gen(function* () {
				const model = yield* Effect.promise(() => llm("openai", "gpt-4o-mini"));
				if (!model) return yield* Effect.die(new Error("aikit did not resolve the OpenAI test model"));
				yield* liveToolConversation(
					model,
					{ apiKey: openaiKey, maxTokens: 128, temperature: 0, maxRetries: 1 },
					"s-live-tool-openai",
				);
			}),
		{ timeout: 120_000 },
	);
});
