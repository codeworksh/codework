import Type from "typebox";
import { describe, expect, it } from "vite-plus/test";
import { Protocol } from "../../src/llm/protocol";
import { Message } from "../../src/message/message";
import { complete } from "../../src/stream";
import {
	anthropicOptions,
	describeIfAnthropic,
	describeIfOpenAI,
	describeIfOpenRouter,
	getAnthropicModel,
	getOpenAIModel,
	getOpenRouterModel,
	getText,
	openaiOptions,
	openrouterOptions,
	type StreamableModel,
} from "../utils/llm";
import { expectAssistantToolUseMessage } from "../utils/message";

type StreamOptionsWithExtras = Protocol.CommonOptions & Record<string, unknown>;

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

function getToolCalls(message: Message.AssistantMessage): Message.ToolCall[] {
	return message.parts.filter((block): block is Message.ToolCall => block.type === "toolCall");
}

async function testToolCallWithoutResult(model: StreamableModel, options: StreamOptionsWithExtras = {}) {
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

	// Verify the response contains valid pending tool calls
	const toolCalls = expectAssistantToolUseMessage(firstResponse);
	for (const toolCall of toolCalls) {
		expect(toolCall.name).toBe("calculate");
	}

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
	const textContent = getText(secondResponse);
	const newToolCalls = getToolCalls(secondResponse);
	expect(newToolCalls.length > 0 || textContent.length > 0).toBe(true);

	// Verify the stop reason is either "stop" or "toolUse" (new tool call)
	expect(["stop", "toolUse"]).toContain(secondResponse.stopReason);
}

describe("Tool Call Without Result Tests", () => {
	describeIfAnthropic("Anthropic Provider", () => {
		const options = anthropicOptions();

		it("should tolerate tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			const model = await getAnthropicModel("claude-sonnet-4-20250514");
			await testToolCallWithoutResult(model, options);
		});
	});

	describeIfOpenAI("OpenAI Provider", () => {
		const options = openaiOptions();

		it("should tolerate tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIModel();
			await testToolCallWithoutResult(model, options);
		});
	});

	describeIfOpenRouter("OpenRouter Provider", () => {
		const options = openrouterOptions();

		it("should tolerate tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenRouterModel();
			await testToolCallWithoutResult(model, options);
		});
	});
});
