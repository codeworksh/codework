/** AI SDK prompt conversion for the OpenAI Codex Responses protocol. */
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import { describe, expect, it } from "vite-plus/test";
import {
	appendOpenAICodexGrammarInputJsonDelta,
	convertToOpenAICodexPrompt,
	joinToolCallId,
	splitToolCallId,
} from "../../src/providers/openai-codex/index.ts";

describe("prompt conversion", () => {
	it("converts system, user, assistant, and tool messages", () => {
		const prompt: LanguageModelV3Prompt = [
			{ role: "system", content: "First." },
			{ role: "system", content: "Second." },
			{ role: "user", content: [{ type: "text", text: "Compute 2+2" }] },
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "let me think" },
					{ type: "tool-call", toolCallId: "call_1|fc_1", toolName: "math", input: { a: 2, b: 2 } },
					{ type: "text", text: "Calling the tool." },
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call_1|fc_1",
						toolName: "math",
						output: { type: "text", value: "4" },
					},
				],
			},
		];

		const { instructions, input } = convertToOpenAICodexPrompt(prompt);

		expect(instructions).toBe("First.\n\nSecond.");
		expect(input).toHaveLength(4);
		expect(input[0]).toEqual({ role: "user", content: [{ type: "input_text", text: "Compute 2+2" }] });
		expect(input[1]).toEqual({
			type: "function_call",
			id: "fc_1",
			call_id: "call_1",
			name: "math",
			arguments: JSON.stringify({ a: 2, b: 2 }),
		});
		expect(input[2]).toMatchObject({
			type: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Calling the tool.", annotations: [] }],
		});
		expect(input[3]).toEqual({ type: "function_call_output", call_id: "call_1", output: "4" });
	});

	it("replays signed reasoning, assistant message ids, and deferred-tool namespaces", () => {
		const signedReasoning = {
			type: "reasoning" as const,
			id: "rs_1",
			summary: [],
			encrypted_content: "encrypted",
		};
		const { input } = convertToOpenAICodexPrompt([
			{
				role: "assistant",
				content: [
					{
						type: "reasoning",
						text: "summary",
						providerOptions: {
							"openai-codex": { reasoningItem: JSON.stringify(signedReasoning) },
						},
					},
					{
						type: "text",
						text: "answer",
						providerOptions: { "openai-codex": { messageId: "msg_1" } },
					},
					{
						type: "tool-call",
						toolCallId: "call_1|fc_1",
						toolName: "search",
						input: { query: "docs" },
						providerOptions: { "openai-codex": { namespace: "workspace" } },
					},
				],
			},
		]);

		expect(input).toEqual([
			signedReasoning,
			{
				type: "message",
				role: "assistant",
				id: "msg_1",
				content: [{ type: "output_text", text: "answer", annotations: [] }],
				status: "completed",
			},
			{
				type: "function_call",
				id: "fc_1",
				call_id: "call_1",
				name: "search",
				arguments: '{"query":"docs"}',
				namespace: "workspace",
			},
		]);
	});

	it("converts image file parts to input_image entries", () => {
		const { input } = convertToOpenAICodexPrompt([
			{
				role: "user",
				content: [
					{ type: "file", mediaType: "image/png", data: "aGVsbG8=" },
					{ type: "file", mediaType: "image/jpeg", data: new URL("https://example.com/cat.jpg") },
				],
			},
		]);

		expect(input[0]).toEqual({
			role: "user",
			content: [
				{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "auto" },
				{ type: "input_image", image_url: "https://example.com/cat.jpg", detail: "auto" },
			],
		});
	});

	it("converts AI SDK V4 image file data to input_image entries", () => {
		const { input } = convertToOpenAICodexPrompt([
			{
				role: "user",
				content: [
					{
						type: "file",
						mediaType: "image/png",
						data: { type: "data", data: "aGVsbG8=" },
					},
				],
			},
		]);

		expect(input[0]).toEqual({
			role: "user",
			content: [{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "auto" }],
		});
	});

	it("defaults instructions when no system message exists", () => {
		const { instructions } = convertToOpenAICodexPrompt([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
		expect(instructions).toBe("You are a helpful assistant.");
	});

	it("round-trips composite tool call ids", () => {
		expect(splitToolCallId(joinToolCallId("call_9", "fc_9"))).toEqual({ callId: "call_9", itemId: "fc_9" });
		expect(splitToolCallId("plain_id")).toEqual({ callId: "plain_id", itemId: "plain_id" });
	});

	it("replays native custom tool calls and results from ordinary AI SDK tool parts", () => {
		const grammarToolInputProperties = new Map([["sample", "payload"]]);
		const { input } = convertToOpenAICodexPrompt(
			[
				{
					role: "assistant",
					content: [
						{
							type: "tool-call",
							toolCallId: "call_1|ctc_1",
							toolName: "sample",
							input: { payload: "abc" },
							providerOptions: { "openai-codex": { namespace: "grammar" } },
						},
					],
				},
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "call_1|ctc_1",
							toolName: "sample",
							output: { type: "text", value: "accepted" },
						},
					],
				},
			],
			{ grammarToolInputProperties },
		);

		expect(input).toEqual([
			{
				type: "custom_tool_call",
				id: "ctc_1",
				call_id: "call_1",
				name: "sample",
				input: "abc",
				namespace: "grammar",
			},
			{ type: "custom_tool_call_output", call_id: "call_1", output: "accepted" },
		]);
	});

	it("produces append-only JSON deltas for raw grammar input", () => {
		const buffer = { input: "", started: false, closed: false };
		expect(appendOpenAICodexGrammarInputJsonDelta(buffer, "payload", 'a"', false)).toBe('{"payload":"a\\"');
		expect(appendOpenAICodexGrammarInputJsonDelta(buffer, "payload", 'a"\nb', true)).toBe('\\nb"}');
		expect(appendOpenAICodexGrammarInputJsonDelta(buffer, "payload", 'a"\nb', true)).toBeUndefined();
	});

	it("omits Responses item ids for non-composite and cross-model tool calls", () => {
		const { input } = convertToOpenAICodexPrompt([
			{
				role: "assistant",
				content: [
					{ type: "tool-call", toolCallId: "plain_id", toolName: "first", input: {} },
					{
						type: "tool-call",
						toolCallId: "call_2|fc_2",
						toolName: "second",
						input: {},
						providerOptions: { "openai-codex": { omitItemId: true } },
					},
				],
			},
		]);

		expect(input).toEqual([
			{ type: "function_call", call_id: "plain_id", name: "first", arguments: "{}" },
			{ type: "function_call", call_id: "call_2", name: "second", arguments: "{}" },
		]);
	});

	it("keeps image tool results inside function_call_output for vision models", () => {
		const prompt: LanguageModelV3Prompt = [
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call_1|fc_1",
						toolName: "screenshot",
						output: {
							type: "content",
							value: [
								{ type: "text", text: "the page" },
								{ type: "file-data", data: "aGVsbG8=", mediaType: "image/png" },
							],
						},
					},
				],
			},
		];

		expect(convertToOpenAICodexPrompt(prompt, { supportsImages: true }).input[0]).toEqual({
			type: "function_call_output",
			call_id: "call_1",
			output: [
				{ type: "input_text", text: "the page" },
				{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "auto" },
			],
		});
		expect(convertToOpenAICodexPrompt(prompt, { supportsImages: false }).input[0]).toEqual({
			type: "function_call_output",
			call_id: "call_1",
			output: "the page",
		});
	});
});
