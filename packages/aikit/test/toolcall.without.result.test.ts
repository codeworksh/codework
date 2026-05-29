import "./utils/env";

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

// Simple calculate tool
const calculateSchema = Type.Object({
	expression: Type.String({ description: "The mathematical expression to evaluate" }),
});

const calculateTool = Message.defineTool({
	name: "calculate",
	description: "Evaluate mathematical expressions",
	parameters: calculateSchema,
});

function createUserMessage(text: string): Message.UserMessage {
	return Message.createUserMessage({
		role: "user",
		parts: [{ type: "text", text }],
		time: { created: Date.now() },
	});
}

function getTextContent(message: Message.AssistantMessage): string {
	return message.parts
		.filter((block): block is Message.TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function getToolCalls(message: Message.AssistantMessage): Message.ToolCall[] {
	return message.parts.filter((block): block is Message.ToolCall => block.type === "toolCall");
}

function expectValidPendingToolCall(toolCall: Message.ToolCall): void {
	expect(toolCall.type).toBe("toolCall");
	expect(toolCall.callID).toBeTruthy();
	expect(toolCall.name).toBe("calculate");
	expect(toolCall.arguments).toBeTypeOf("object");
	expect(toolCall.arguments).not.toBeNull();
	expect(toolCall.status).toBe("pending");
	expect(typeof toolCall.time.start).toBe("number");
	expect(typeof toolCall.time.end).toBe("number");
	expect(toolCall.time.end).toBeGreaterThanOrEqual(toolCall.time.start);
}

async function testToolCallWithoutResult(model: Model.Info, options: StreamOptionsWithExtras = {}) {
	// Step 1: Create context with the calculate tool
	const context: Message.Context = {
		systemPrompt: "You are a helpful assistant. Use the calculate tool when asked to perform calculations.",
		messages: [],
		tools: [calculateTool],
	};

	// Step 2: Ask the LLM to make a tool call
	context.messages.push(createUserMessage("Please calculate 25 * 18 using the calculate tool."));

	// Step 3: Get the assistant's response (should contain a tool call)
	const firstResponse = await complete(model, context, options);
	context.messages.push(firstResponse);

	// Verify the response contains a tool call
	const toolCalls = getToolCalls(firstResponse);
	const hasToolCall = toolCalls.length > 0;
	expect(hasToolCall).toBe(true);

	if (!hasToolCall) {
		throw new Error("Expected assistant to make a tool call, but none was found");
	}

	for (const toolCall of toolCalls) {
		expectValidPendingToolCall(toolCall);
	}
	expect(firstResponse.stopReason).toBe("toolUse");

	// Step 4: Send a user message WITHOUT providing tool result
	// This simulates the scenario where a tool call was aborted/cancelled
	context.messages.push(createUserMessage("Never mind, just tell me what is 2+2?"));

	// Step 5: The provider integration should tolerate the orphaned tool call, and the request should succeed
	const secondResponse = await complete(model, context, options);

	// The request should succeed (not error) - that's the main thing we're testing
	expect(secondResponse.stopReason, secondResponse.errorMessage).not.toBe("error");

	// Should have some content in the response
	expect(secondResponse.parts.length).toBeGreaterThan(0);

	// The LLM may choose to answer directly or make a new tool call - either is fine
	// The important thing is it didn't fail with the orphaned tool call error
	const textContent = getTextContent(secondResponse);
	const newToolCalls = getToolCalls(secondResponse).length;
	expect(newToolCalls || textContent.length).toBeGreaterThan(0);

	// Verify the stop reason is either "stop" or "toolUse" (new tool call)
	expect(["stop", "toolUse"]).toContain(secondResponse.stopReason);
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

describe("Tool Call Without Result Tests", () => {
	describeIfAnthropic("Anthropic Provider", () => {
		const options: AnthropicOptions = {
			apiKey: process.env.ANTHROPIC_API_KEY,
		};

		it("should tolerate tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			const model = await getAnthropicModel();
			await testToolCallWithoutResult(model, options);
		});
	});

	describeIfOpenAI("OpenAI Provider", () => {
		const options: OpenAIOptions = {
			apiKey: process.env.OPENAI_API_KEY,
		};

		it("should tolerate tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIModel();
			await testToolCallWithoutResult(model, options);
		});
	});

	describeIfOpenRouter("OpenRouter Provider", () => {
		const options: OpenRouterOptions = {
			apiKey: process.env.OPENROUTER_API_KEY,
			headers: {
				"HTTP-Referer": "https://www.codework.sh",
				"X-OpenRouter-Title": "CodeWork",
				"X-OpenRouter-Categories": "cli-agent,personal-agent",
			},
		};

		it("should tolerate tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenRouterModel();
			await testToolCallWithoutResult(model, options);
		});
	});
});
