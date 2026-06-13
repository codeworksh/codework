import type { FinishReason, LanguageModelUsage } from "ai";
import Type from "typebox";
import { describe, expect, it } from "vite-plus/test";
import { convertMessages, convertTools, mapFinishReason, mapUsage } from "../src/llm/transform";
import { Message } from "../src/message/message";
import {
	makeAssistantMessage,
	makeCompletedToolCall,
	makeModel,
	makePendingToolCall,
	makeUserMessage,
} from "./utils/fixtures";

describe("mapFinishReason", () => {
	const cases: Array<[FinishReason | undefined, Message.StopReason]> = [
		["stop", "stop"],
		["length", "length"],
		["tool-calls", "toolUse"],
		["content-filter", "error"],
		["error", "error"],
		["other", "error"],
		[undefined, "stop"],
	];

	it.each(cases)("maps %s to %s", (reason, expected) => {
		expect(mapFinishReason(reason)).toBe(expected);
	});
});

describe("mapUsage", () => {
	const model = makeModel({
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	});

	it("returns zeros for undefined usage", () => {
		const usage = mapUsage(undefined, model);
		expect(usage).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
	});

	it("subtracts cached tokens from inputTokens when no breakdown is available", () => {
		const usage = mapUsage(
			{ inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 30 } as LanguageModelUsage,
			model,
		);
		expect(usage.input).toBe(70);
		expect(usage.cacheRead).toBe(30);
		expect(usage.output).toBe(50);
		expect(usage.totalTokens).toBe(150);
	});

	it("prefers inputTokenDetails when present", () => {
		const usage = mapUsage(
			{
				inputTokens: 100,
				outputTokens: 10,
				totalTokens: 110,
				inputTokenDetails: { noCacheTokens: 40, cacheReadTokens: 35, cacheWriteTokens: 25 },
			} as LanguageModelUsage,
			model,
		);
		expect(usage.input).toBe(40);
		expect(usage.cacheRead).toBe(35);
		expect(usage.cacheWrite).toBe(25);
	});

	it("never reports negative input tokens", () => {
		const usage = mapUsage(
			{ inputTokens: 10, outputTokens: 0, totalTokens: 10, cachedInputTokens: 50 } as LanguageModelUsage,
			model,
		);
		expect(usage.input).toBe(0);
	});

	it("computes totalTokens from components when the provider omits it", () => {
		const usage = mapUsage(
			{
				inputTokens: 100,
				outputTokens: 50,
				cachedInputTokens: 30,
				totalTokens: undefined,
			} as unknown as LanguageModelUsage,
			model,
		);
		expect(usage.totalTokens).toBe(70 + 30 + 0 + 50);
	});

	it("calculates cost from per-million-token model pricing", () => {
		const usage = mapUsage(
			{
				inputTokens: 2_000_000,
				outputTokens: 1_000_000,
				totalTokens: 3_000_000,
				inputTokenDetails: { noCacheTokens: 1_000_000, cacheReadTokens: 600_000, cacheWriteTokens: 400_000 },
			} as LanguageModelUsage,
			model,
		);
		expect(usage.cost.input).toBeCloseTo(3);
		expect(usage.cost.output).toBeCloseTo(15);
		expect(usage.cost.cacheRead).toBeCloseTo(0.18);
		expect(usage.cost.cacheWrite).toBeCloseTo(1.5);
		expect(usage.cost.total).toBeCloseTo(3 + 15 + 0.18 + 1.5);
	});
});

describe("convertTools", () => {
	it("returns undefined for missing or empty tools", () => {
		expect(convertTools(undefined)).toBeUndefined();
		expect(convertTools([])).toBeUndefined();
	});

	it("converts tool definitions to an AI SDK ToolSet keyed by name", () => {
		const tool = Message.defineTool({
			name: "search",
			description: "Search documents",
			parameters: Type.Object({ query: Type.String() }),
		});

		const toolSet = convertTools([tool]);
		expect(toolSet).toBeDefined();
		expect(Object.keys(toolSet!)).toEqual(["search"]);
		expect(toolSet!.search!.description).toBe("Search documents");
		expect(toolSet!.search!.inputSchema).toBeDefined();
	});
});

describe("convertMessages", () => {
	const model = makeModel({ input: ["text", "image"] });

	it("converts user text messages", () => {
		const messages = convertMessages({ messages: [makeUserMessage("hello")] }, model);
		expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
	});

	it("drops whitespace-only user text and empty user messages", () => {
		const messages = convertMessages({ messages: [makeUserMessage("  \n\t ")] }, model);
		expect(messages).toEqual([]);
	});

	it("includes user images only when the model supports image input", () => {
		const userMessage = Message.createUserMessage({
			role: "user",
			parts: [
				{ type: "text", text: "look" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			],
			time: { created: Date.now() },
		});

		const withImages = convertMessages({ messages: [userMessage] }, model);
		expect(withImages[0]).toMatchObject({
			role: "user",
			content: [
				{ type: "text", text: "look" },
				{ type: "image", image: "aGVsbG8=", mediaType: "image/png" },
			],
		});

		const textOnlyModel = makeModel({ input: ["text"] });
		const withoutImages = convertMessages({ messages: [userMessage] }, textOnlyModel);
		expect(withoutImages[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "look" }],
		});
	});

	it("sanitizes unpaired surrogates in user text", () => {
		const unpaired = String.fromCharCode(0xd83d);
		const messages = convertMessages({ messages: [makeUserMessage(`bad ${unpaired} char`)] }, model);
		expect(messages[0]).toMatchObject({
			content: [{ type: "text", text: "bad  char" }],
		});
	});

	it("drops assistant messages that errored or were aborted", () => {
		const errored = makeAssistantMessage(model, {
			stopReason: "error",
			parts: [{ type: "text", text: "partial" }],
		});
		const aborted = makeAssistantMessage(model, {
			stopReason: "aborted",
			parts: [{ type: "text", text: "partial" }],
		});

		const messages = convertMessages({ messages: [makeUserMessage("hi"), errored, aborted] }, model);
		expect(messages).toHaveLength(1);
		expect(messages[0]!.role).toBe("user");
	});

	it("converts assistant text and skips empty text parts", () => {
		const assistant = makeAssistantMessage(model, {
			parts: [
				{ type: "text", text: "answer" },
				{ type: "text", text: "   " },
			],
		});

		const messages = convertMessages({ messages: [assistant] }, model);
		expect(messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "answer" }] }]);
	});

	it("emits reasoning parts with the provider signature for same-model replay", () => {
		const assistant = makeAssistantMessage(model, {
			parts: [{ type: "thinking", thinking: "step by step", thinkingSignature: "sig-1" }],
		});

		const messages = convertMessages({ messages: [assistant] }, model);
		expect(messages).toEqual([
			{
				role: "assistant",
				content: [
					{
						type: "reasoning",
						text: "step by step",
						providerOptions: { anthropic: { signature: "sig-1" } },
					},
				],
			},
		]);
	});

	it("converts completed tool calls into tool-call plus tool-result messages", () => {
		const assistant = makeAssistantMessage(model, {
			stopReason: "toolUse",
			parts: [makeCompletedToolCall("call-1", "search", [{ type: "text", text: "found it" }], { query: "x" })],
		});

		const messages = convertMessages({ messages: [assistant] }, model);
		expect(messages).toEqual([
			{
				role: "assistant",
				content: [{ type: "tool-call", toolCallId: "call-1", toolName: "search", input: { query: "x" } }],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call-1",
						toolName: "search",
						output: { type: "text", value: "found it" },
					},
				],
			},
		]);
	});

	it("synthesizes an error result for unresolved tool calls", () => {
		const assistant = makeAssistantMessage(model, {
			stopReason: "toolUse",
			parts: [makePendingToolCall("call-1", "search")],
		});

		const messages = convertMessages({ messages: [assistant] }, model);
		const toolMessage = messages.find((message) => message.role === "tool");
		expect(toolMessage).toMatchObject({
			content: [
				{
					type: "tool-result",
					toolCallId: "call-1",
					output: { type: "error-text", value: "No result provided" },
				},
			],
		});
	});

	it("converts error tool results to error-text output", () => {
		const toolCall: Message.ToolCall = {
			...makePendingToolCall("call-1", "search"),
			status: "error",
			result: { content: [{ type: "text", text: "request failed" }], isError: true },
		};
		const assistant = makeAssistantMessage(model, { stopReason: "toolUse", parts: [toolCall] });

		const messages = convertMessages({ messages: [assistant] }, model);
		const toolMessage = messages.find((message) => message.role === "tool");
		expect(toolMessage).toMatchObject({
			content: [{ output: { type: "error-text", value: "request failed" } }],
		});
	});

	it("falls back to a generic message for empty error results", () => {
		const toolCall: Message.ToolCall = {
			...makePendingToolCall("call-1", "search"),
			status: "error",
			result: { content: [], isError: true },
		};
		const assistant = makeAssistantMessage(model, { stopReason: "toolUse", parts: [toolCall] });

		const messages = convertMessages({ messages: [assistant] }, model);
		const toolMessage = messages.find((message) => message.role === "tool");
		expect(toolMessage).toMatchObject({
			content: [{ output: { type: "error-text", value: "Tool returned an error" } }],
		});
	});

	it("converts tool results with images to content output", () => {
		const assistant = makeAssistantMessage(model, {
			stopReason: "toolUse",
			parts: [
				makeCompletedToolCall("call-1", "screenshot", [
					{ type: "text", text: "the page" },
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				]),
			],
		});

		const messages = convertMessages({ messages: [assistant] }, model);
		const toolMessage = messages.find((message) => message.role === "tool");
		expect(toolMessage).toMatchObject({
			content: [
				{
					output: {
						type: "content",
						value: [
							{ type: "text", text: "the page" },
							{ type: "image-data", data: "aGVsbG8=", mediaType: "image/png" },
						],
					},
				},
			],
		});
	});

	it("sanitizes unpaired surrogates in tool arguments and results", () => {
		const unpaired = String.fromCharCode(0xd83d);
		const assistant = makeAssistantMessage(model, {
			stopReason: "toolUse",
			parts: [
				makeCompletedToolCall("call-1", "echo", [{ type: "text", text: `out ${unpaired} put` }], {
					note: `in ${unpaired} put`,
					nested: { list: [`x ${unpaired} y`] },
				}),
			],
		});

		const messages = convertMessages({ messages: [assistant] }, model);
		expect(messages[0]).toMatchObject({
			content: [{ input: { note: "in  put", nested: { list: ["x  y"] } } }],
		});
		expect(messages[1]).toMatchObject({
			content: [{ output: { value: "out  put" } }],
		});
	});
});
