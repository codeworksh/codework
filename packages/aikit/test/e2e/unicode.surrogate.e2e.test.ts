import dedent from "dedent";
import Type from "typebox";
import { describe, expect, it } from "vite-plus/test";
import { Protocol } from "../../src/llm/protocol";
import { Message } from "../../src/message/message";
import { Model } from "../../src/model/model";
import { complete } from "../../src/stream";
import { makeAssistantMessage, makePendingToolCall } from "../utils/fixtures";
import {
	anthropicOptions,
	describeIfAnthropic,
	describeIfOpenAI,
	describeIfOpenRouter,
	getAnthropicModel,
	getOpenAIModel,
	getOpenRouterModel,
	openaiOptions,
	openrouterOptions,
	type StreamableModel,
} from "../utils/llm";

type StreamOptionsWithExtras = Protocol.CommonOptions & Record<string, unknown>;

// Empty schema for test tools - must be proper OBJECT type
const emptySchema = Type.Object({});

function createUserMessage(text: string): Message.UserMessage {
	return Message.createUserMessage({
		role: "user",
		parts: [{ type: "text", text }],
		time: { created: Date.now() },
	});
}

/**
 * Build a context holding a user request plus an assistant message with a
 * pending tool call, then resolve that tool call with the given result text.
 */
function createToolResultContext(
	model: Model.Info,
	toolName: string,
	toolCallId: string,
	resultText: string,
	followUp: string,
): Message.Context {
	const completedToolCall: Message.ToolCallCompletedPart = {
		...makePendingToolCall(toolCallId, toolName),
		status: "completed",
		result: {
			content: [{ type: "text", text: resultText }],
			isError: false,
		},
	};

	return {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			createUserMessage(`Use the ${toolName} tool`),
			makeAssistantMessage(model, {
				stopReason: "toolUse",
				parts: [completedToolCall],
			}),
			createUserMessage(followUp),
		],
		tools: [
			{
				name: toolName,
				description: "A test tool",
				parameters: emptySchema,
			},
		],
	};
}

/**
 * Test for Unicode surrogate pair handling in tool results.
 *
 * Issue: When tool results contain emoji or other characters outside the Basic Multilingual Plane,
 * they may be incorrectly serialized as unpaired surrogates, causing "no low surrogate in string"
 * errors when sent to the API provider.
 *
 * Example error from Anthropic:
 * "The request body is not valid JSON: no low surrogate in string: line 1 column 197667"
 */
async function testEmojiInToolResults(model: StreamableModel, options: StreamOptionsWithExtras = {}) {
	const context = createToolResultContext(
		model,
		"test_tool",
		"test_1",
		dedent`
			Test with emoji 🙈 and other characters:
			- Monkey emoji: 🙈
			- Thumbs up: 👍
			- Heart: ❤️
			- Thinking face: 🤔
			- Rocket: 🚀
			- Mixed text: करें चाय पे चर्चा 🙈
			- Japanese: こんにちは
			- Chinese: 你好
			- Mathematical symbols: ∑∫∂√
			- Special quotes: "curly" 'quotes'
		`,
		"Summarize the tool result briefly.",
	);

	// This should not throw a surrogate pair error
	const response = await complete(model, context, options);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.parts.length).toBeGreaterThan(0);
}

async function testRealWorldLinkedInData(model: StreamableModel, options: StreamOptionsWithExtras = {}) {
	const context = createToolResultContext(
		model,
		"linkedin_skill",
		"linkedin_1",
		dedent`
			Post: Just launched our new 'AI-Driven Productivity' corporate training module! 🚀
			Unanswered Comments: 2
			=> {
			  "comments": [
			    {
			      "author": "L&D Director at Apex Corp",
			      "text": "Perfect timing! 😍 Sending a DM to chat about a pilot program for our team! 🏢🚀"
			    },
			    {
			      "author": "Senior Project Manager",
			      "text": "Saving 5 hours a week? Sign me up! 🙋‍♂️ Real, practical application. Congrats! 🎉🙌"
			    }
			  ]
			}
		`,
		"How many comments are there?",
	);

	// This should not throw a surrogate pair error
	const response = await complete(model, context, options);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.parts.some((b) => b.type === "text")).toBe(true);
}

async function testUnpairedHighSurrogate(model: StreamableModel, options: StreamOptionsWithExtras = {}) {
	// Construct a string with an intentionally unpaired high surrogate
	// This simulates what might happen if text processing corrupts emoji
	const unpairedSurrogate = String.fromCharCode(0xd83d); // High surrogate without low surrogate

	const context = createToolResultContext(
		model,
		"test_tool",
		"test_2",
		`Text with unpaired surrogate: ${unpairedSurrogate} <- should be sanitized`,
		"What did the tool return?",
	);

	// This should not throw a surrogate pair error
	// The unpaired surrogate should be sanitized before sending to API
	const response = await complete(model, context, options);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.parts.length).toBeGreaterThan(0);
}

describe("AI Providers Unicode Surrogate Pair Tests", () => {
	describeIfAnthropic("Anthropic Provider Unicode Handling", () => {
		const options = anthropicOptions();

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			const model = await getAnthropicModel("claude-sonnet-4-20250514");
			await testEmojiInToolResults(model, options);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			const model = await getAnthropicModel("claude-sonnet-4-20250514");
			await testRealWorldLinkedInData(model, options);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			const model = await getAnthropicModel("claude-sonnet-4-20250514");
			await testUnpairedHighSurrogate(model, options);
		});
	});

	describeIfOpenAI("OpenAI Provider Unicode Handling", () => {
		const options = openaiOptions();

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIModel();
			await testEmojiInToolResults(model, options);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIModel();
			await testRealWorldLinkedInData(model, options);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIModel();
			await testUnpairedHighSurrogate(model, options);
		});
	});

	describeIfOpenRouter("OpenRouter Provider Unicode Handling", () => {
		const options = openrouterOptions();

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenRouterModel();
			await testEmojiInToolResults(model, options);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenRouterModel();
			await testRealWorldLinkedInData(model, options);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenRouterModel();
			await testUnpairedHighSurrogate(model, options);
		});
	});
});
