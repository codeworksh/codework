import "./utils/env";

import dedent from "dedent";
import Type from "typebox";
import { describe, expect, it } from "vite-plus/test";
import { llm } from "../src/llm";
import type { AnthropicOptions, OpenAIOptions, OpenRouterOptions } from "../src/llm/options";
import { Protocol } from "../src/llm/protocol";
import { Message } from "../src/message/message";
import { Model } from "../src/model/model";
import { complete } from "../src/stream";

type StreamOptionsWithExtras = Protocol.CommonOptions & Record<string, unknown>;

const describeIfAnthropic = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;
const describeIfOpenAI = process.env.OPENAI_API_KEY ? describe : describe.skip;
const describeIfOpenRouter = process.env.OPENROUTER_API_KEY ? describe : describe.skip;

// Empty schema for test tools - must be proper OBJECT type
const emptySchema = Type.Object({});

function addToolResultToContext(context: Message.Context, toolResult: Message.ToolCallCompletedPart): void {
	const assistantMessage = context.messages[1];
	if (!assistantMessage || assistantMessage.role !== "assistant") {
		throw new Error("Expected assistant tool-call message at index 1");
	}
	assistantMessage.parts[0] = toolResult;
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
async function testEmojiInToolResults(model: Model.Info, options: StreamOptionsWithExtras = {}) {
	const toolCallId = "test_1";
	// Simulate a tool that returns emoji
	const context: Message.Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			Message.createUserMessage({
				role: "user",
				parts: [{ type: "text", text: "Use the test tool" }],
				time: { created: Date.now() },
			}),
			Message.createAssistantMessage({
				role: "assistant",
				parts: [
					{
						type: "toolCall",
						callID: toolCallId,
						name: "test_tool",
						arguments: {},
						status: "pending",
						time: {
							start: Date.now(),
							end: Date.now(),
						},
					},
				],
				protocol: model.protocol,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				time: {
					created: Date.now(),
					completed: Date.now(),
				},
			}),
		],
		tools: [
			{
				name: "test_tool",
				description: "A test tool",
				parameters: emptySchema,
			},
		],
	};

	// Add tool result with various problematic Unicode characters
	const toolResult: Message.ToolCallCompletedPart = {
		type: "toolCall",
		callID: toolCallId,
		name: "test_tool",
		arguments: {},
		status: "completed",
		result: {
			content: [
				{
					type: "text",
					text: dedent`
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
				},
			],
			isError: false,
		},
		time: {
			start: Date.now(),
			end: Date.now(),
		},
	};

	addToolResultToContext(context, toolResult);

	// Add follow-up user message
	context.messages.push(
		Message.createUserMessage({
			role: "user",
			parts: [{ type: "text", text: "Summarize the tool result briefly." }],
			time: { created: Date.now() },
		}),
	);

	// This should not throw a surrogate pair error
	const response = await complete(model, context, options);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.parts.length).toBeGreaterThan(0);
}

async function testRealWorldLinkedInData(model: Model.Info, options: StreamOptionsWithExtras = {}) {
	const toolCallId = "linkedin_1";
	const context: Message.Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			Message.createUserMessage({
				role: "user",
				parts: [{ type: "text", text: "Use the linkedin tool to get comments" }],
				time: { created: Date.now() },
			}),
			Message.createAssistantMessage({
				role: "assistant",
				parts: [
					{
						type: "toolCall",
						callID: toolCallId,
						name: "linkedin_skill",
						arguments: {},
						status: "pending",
						time: {
							start: Date.now(),
							end: Date.now(),
						},
					},
				],
				protocol: model.protocol,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				time: {
					created: Date.now(),
					completed: Date.now(),
				},
			}),
		],
		tools: [
			{
				name: "linkedin_skill",
				description: "Get LinkedIn comments",
				parameters: emptySchema,
			},
		],
	};

	// Real-world tool result from LinkedIn with emoji
	const toolResult: Message.ToolCallCompletedPart = {
		type: "toolCall",
		callID: toolCallId,
		name: "linkedin_skill",
		arguments: {},
		status: "completed",
		result: {
			content: [
				{
					type: "text",
					text: dedent`
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
				},
			],
			isError: false,
		},
		time: {
			start: Date.now(),
			end: Date.now(),
		},
	};

	addToolResultToContext(context, toolResult);

	context.messages.push(
		Message.createUserMessage({
			role: "user",
			parts: [{ type: "text", text: "How many comments are there?" }],
			time: { created: Date.now() },
		}),
	);

	// This should not throw a surrogate pair error
	const response = await complete(model, context, options);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.parts.some((b) => b.type === "text")).toBe(true);
}

async function testUnpairedHighSurrogate(model: Model.Info, options: StreamOptionsWithExtras = {}) {
	const toolCallId = "test_2";
	const context: Message.Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			Message.createUserMessage({
				role: "user",
				parts: [{ type: "text", text: "Use the test tool" }],
				time: { created: Date.now() },
			}),
			Message.createAssistantMessage({
				role: "assistant",
				parts: [
					{
						type: "toolCall",
						callID: toolCallId,
						name: "test_tool",
						arguments: {},
						status: "pending",
						time: {
							start: Date.now(),
							end: Date.now(),
						},
					},
				],
				protocol: model.protocol,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				time: {
					created: Date.now(),
					completed: Date.now(),
				},
			}),
		],
		tools: [
			{
				name: "test_tool",
				description: "A test tool",
				parameters: emptySchema,
			},
		],
	};

	// Construct a string with an intentionally unpaired high surrogate
	// This simulates what might happen if text processing corrupts emoji
	const unpairedSurrogate = String.fromCharCode(0xd83d); // High surrogate without low surrogate

	const toolResult: Message.ToolCallCompletedPart = {
		type: "toolCall",
		callID: toolCallId,
		name: "test_tool",
		arguments: {},
		status: "completed",
		result: {
			content: [
				{
					type: "text",
					text: `Text with unpaired surrogate: ${unpairedSurrogate} <- should be sanitized`,
				},
			],
			isError: false,
		},
		time: {
			start: Date.now(),
			end: Date.now(),
		},
	};

	addToolResultToContext(context, toolResult);

	context.messages.push(
		Message.createUserMessage({
			role: "user",
			parts: [{ type: "text", text: "What did the tool return?" }],
			time: { created: Date.now() },
		}),
	);

	// This should not throw a surrogate pair error
	// The unpaired surrogate should be sanitized before sending to API
	const response = await complete(model, context, options);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.parts.length).toBeGreaterThan(0);
}

function assertAnthropicModel(
	model: Model.Info | undefined,
): asserts model is Model.TModel<typeof Model.KnownProviderEnum.anthropic> {
	if (!model) {
		throw new Error("Expected Anthropic model to be defined");
	}
	if (model.protocol !== Model.KnownProviderEnum.anthropic) {
		throw new Error(`Expected anthropic protocol, received ${model.protocol}`);
	}
}

function assertOpenAIModel(
	model: Model.Info | undefined,
): asserts model is Model.TModel<typeof Model.KnownProviderEnum.openai> {
	if (!model) {
		throw new Error("Expected OpenAI model to be defined");
	}
	if (model.protocol !== Model.KnownProviderEnum.openai) {
		throw new Error(`Expected openai protocol, received ${model.protocol}`);
	}
}

function assertOpenRouterModel(
	model: Model.Info | undefined,
): asserts model is Model.TModel<typeof Model.KnownProviderEnum.openrouter> {
	if (!model) {
		throw new Error("Expected OpenRouter model to be defined");
	}
	if (model.protocol !== Model.KnownProviderEnum.openrouter) {
		throw new Error(`Expected openrouter protocol, received ${model.protocol}`);
	}
}

async function getAnthropicModel(): Promise<Model.TModel<typeof Model.KnownProviderEnum.anthropic>> {
	const model = await llm("anthropic", "claude-sonnet-4-20250514");
	assertAnthropicModel(model);
	return model;
}

async function getOpenAIModel(): Promise<Model.TModel<typeof Model.KnownProviderEnum.openai>> {
	const model = await llm("openai", "gpt-4o-mini");
	assertOpenAIModel(model);
	return model;
}

async function getOpenRouterModel(): Promise<Model.TModel<typeof Model.KnownProviderEnum.openrouter>> {
	const model = await llm("openrouter", "deepseek/deepseek-v4-flash");
	assertOpenRouterModel(model);
	return model;
}

describe("AI Providers Unicode Surrogate Pair Tests", () => {
	describeIfAnthropic("Anthropic Provider Unicode Handling", () => {
		const options: AnthropicOptions = {
			apiKey: process.env.ANTHROPIC_API_KEY,
		};

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			const model = await getAnthropicModel();
			await testEmojiInToolResults(model, options);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			const model = await getAnthropicModel();
			await testRealWorldLinkedInData(model, options);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			const model = await getAnthropicModel();
			await testUnpairedHighSurrogate(model, options);
		});
	});

	describeIfOpenAI("OpenAI Provider Unicode Handling", () => {
		const options: OpenAIOptions = {
			apiKey: process.env.OPENAI_API_KEY,
		};

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
		const options: OpenRouterOptions = {
			apiKey: process.env.OPENROUTER_API_KEY,
			headers: {
				"HTTP-Referer": "https://www.codework.sh",
				"X-OpenRouter-Title": "CodeWork",
				"X-OpenRouter-Categories": "cli-agent,personal-agent",
			},
		};

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
