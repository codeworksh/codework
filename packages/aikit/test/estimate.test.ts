import { describe, expect, it } from "vite-plus/test";
import { clampMaxTokensToContext } from "../src/llm/shared.ts";
import * as Message from "../src/message/message.ts";
import { estimateContextTokens, estimateMessageTokens, estimateTextTokens } from "../src/utils/estimate.ts";
import { makeModel, makeUsage } from "./utils/fixtures.ts";

const model = makeModel({ contextWindow: 10_000, maxTokens: 8_000 });

function user(text: string, created: number): Message.UserMessage {
	return Message.createUserMessage({ role: "user", parts: [{ type: "text", text }], time: { created } });
}

function assistant(created: number, totalTokens: number): Message.AssistantMessage {
	return Message.createAssistantMessage({
		role: "assistant",
		parts: [{ type: "text", text: "kept" }],
		protocol: model.protocol,
		provider: model.provider,
		model: model.id,
		usage: makeUsage({ input: totalTokens, totalTokens }),
		stopReason: "stop",
		time: { created, completed: created },
	});
}

describe("estimateTextTokens", () => {
	it("counts four characters to the token, rounding up", () => {
		expect(estimateTextTokens("")).toBe(0);
		expect(estimateTextTokens("abc")).toBe(1);
		expect(estimateTextTokens("x".repeat(4_000))).toBe(1_000);
	});
});

describe("estimateMessageTokens", () => {
	it("charges a flat cost for images rather than their base64 length", () => {
		const withImage = Message.createUserMessage({
			role: "user",
			parts: [{ type: "image", data: "a".repeat(10), mimeType: "image/png" }],
			time: { created: 1 },
		});
		expect(estimateMessageTokens(withImage)).toBe(1_200);
	});

	it("counts thinking, tool arguments, and the results a tool call carries", () => {
		const message = Message.createAssistantMessage({
			role: "assistant",
			parts: [
				{ type: "thinking", thinking: "t".repeat(400) },
				{
					type: "toolCall",
					callID: "c1",
					name: "read",
					arguments: {},
					status: "completed",
					result: { content: [{ type: "text", text: "r".repeat(400) }], isError: false },
					time: { start: 1, end: 2 },
				},
			],
			protocol: model.protocol,
			provider: model.provider,
			model: model.id,
			usage: makeUsage(),
			stopReason: "stop",
			time: { created: 1, completed: 2 },
		});

		// 400 thinking + 4 name + 2 args ("{}") + 400 result = 806 chars
		expect(estimateMessageTokens(message)).toBe(Math.ceil(806 / 4));
	});
});

describe("estimateContextTokens", () => {
	it("ignores stale assistant usage after a newer message is inserted before it", () => {
		const context: Message.Context = {
			systemPrompt: "system",
			messages: [user("summary", 200), assistant(100, 9_500), user("x".repeat(4_000), 300)],
		};

		expect(estimateContextTokens(context)).toEqual({
			tokens: 1_005,
			usageTokens: 0,
			trailingTokens: 1_005,
			lastUsageIndex: null,
		});
	});

	it("uses assistant usage again after a response to the inserted context", () => {
		const context: Message.Context = {
			messages: [
				user("summary", 200),
				assistant(100, 9_500),
				user("new prompt", 300),
				assistant(400, 2_000),
				user("tail", 500),
			],
		};

		expect(estimateContextTokens(context)).toEqual({
			tokens: 2_001,
			usageTokens: 2_000,
			trailingTokens: 1,
			lastUsageIndex: 3,
		});
	});

	it("skips usage from an aborted or failed turn", () => {
		const failed = { ...assistant(100, 9_500), stopReason: "error" as const };
		const context: Message.Context = { messages: [failed, user("tail", 200)] };

		expect(estimateContextTokens(context).lastUsageIndex).toBeNull();
	});

	it("sizes a response ceiling against what the conversation already spends", () => {
		const context: Message.Context = {
			systemPrompt: "system",
			messages: [user("summary", 200), assistant(100, 9_500), user("x".repeat(4_000), 300)],
		};

		// 10_000 window - 1_005 estimated - 4_096 safety
		expect(clampMaxTokensToContext(model, context, 8_000)).toBe(4_899);
	});
});
