import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Type from "typebox";
import { describe, expect, it } from "vite-plus/test";
import { Protocol } from "../../src/llm/protocol";
import { Message } from "../../src/message/message";
import { Model } from "../../src/model/model";
import { stream } from "../../src/stream";
import { StringEnum } from "../../src/utils/helpers";
import {
	anthropicOptions,
	describeIfAnthropic,
	describeIfOpenAI,
	describeIfOpenAICodex,
	describeIfOpenRouter,
	getAnthropicModel,
	getOpenAICodexModel,
	getOpenAIModel,
	getOpenRouterModel,
	getText,
	openaiCodexOptions,
	openaiOptions,
	openrouterOptions,
	type StreamableModel,
} from "../utils/llm";
import { expectAssistantToolUseMessage, expectValidToolCall } from "../utils/message";

async function basicTextGeneration<TOptions extends Protocol.CommonOptions>(model: StreamableModel, options: TOptions) {
	const context = {
		systemPrompt: "You are a helpful assistant. Be concise.",
		messages: [
			Message.createUserMessage({
				role: "user",
				time: {
					created: Date.now(),
				},
				parts: [
					{
						type: "text",
						text: "Reply with exactly: Hello test successful",
					},
				],
			}),
		],
	};
	const response = await stream.complete(model, context, options);

	expect(response.role).toBe("assistant");
	expect(response.provider.id).toBe(model.provider.id);
	expect(response.model).toBe(model.id);
	expect(response.usage.input + response.usage.cacheRead).toBeGreaterThan(0);
	expect(response.usage.output).toBeGreaterThan(0);
	expect(response.errorMessage).toBeFalsy();
	expect(response.parts.length).toBeGreaterThan(0);
	expect(getText(response)).toContain("Hello test successful");
}

// Calculator tool definition (same as examples)
// Note: Using StringEnum helper because Google's API doesn't support anyOf/const patterns
// that Type.Enum generates. Google requires { type: "string", enum: [...] } format.
const calculatorSchema = Type.Object({
	a: Type.Number({ description: "First number" }),
	b: Type.Number({ description: "Second number" }),
	operation: StringEnum(["add", "subtract", "multiply", "divide"], {
		description: "The operation to perform. One of 'add', 'subtract', 'multiply', 'divide'.",
	}),
});

const calculatorTool = Message.defineTool({
	name: "math_operation",
	description: "The operation to perform. One of `add`, `subtract`, `multiply`, `divide`",
	parameters: calculatorSchema,
});

async function handleToolCall<TOptions extends Protocol.CommonOptions>(model: StreamableModel, options: TOptions) {
	const context: Message.Context = {
		systemPrompt: "You are helpful assistant that uses tools when asked",
		messages: [
			Message.createUserMessage({
				role: "user",
				time: {
					created: Date.now(),
				},
				parts: [
					{
						type: "text",
						text: "Calculate 15 + 27 using `math_operation` tool.",
					},
				],
			}),
		],
		tools: [calculatorTool],
	};

	const s = stream(model, context, options);
	let hasToolStart = false;
	let hasToolDelta = false;
	let hasToolEnd = false;
	let hasToolFinal = false;
	let accumulatedToolArgs = "";
	let index: number | undefined;
	let callId: string | undefined;

	for await (const event of s) {
		if (event.type === "toolcall.start") {
			hasToolStart = true;
			const toolCall = event.partial.parts[event.partIndex];
			index = event.partIndex;
			expect(toolCall.type).toBe("toolCall");
			if (toolCall.type === "toolCall") {
				expect(toolCall.name).toBe("math_operation");
				expect(toolCall.callID).toBeTruthy();
				callId = toolCall.callID;
			}
		}
		if (event.type === "toolcall.delta") {
			hasToolDelta = true;
			const toolCall = event.partial.parts[event.partIndex];
			if (index !== undefined) expect(event.partIndex).toBe(index); // must be the same parts index
			expect(toolCall.type).toBe("toolCall");
			if (toolCall.type === "toolCall") {
				expect(toolCall.name).toBe("math_operation");
				accumulatedToolArgs += event.delta;
				// Check that we have a parsed arguments object during streaming
				expect(toolCall.arguments).toBeDefined();
				expect(typeof toolCall.arguments).toBe("object");
				// The arguments should be partially populated as we stream
				// At minimum it should be an empty object, never undefined
				expect(toolCall.arguments).not.toBeNull();
				expect(toolCall.callID).toEqual(callId); // must have same call ID
			}
		}
		if (event.type === "toolcall.end") {
			hasToolEnd = true;
			const toolCall = event.partial.parts[event.partIndex];
			if (index !== undefined) expect(event.partIndex).toBe(index);
			expect(toolCall.type).toBe("toolCall");
			if (toolCall.type === "toolCall") {
				expect(toolCall.name).toBe("math_operation");
				if (accumulatedToolArgs) expect(() => JSON.parse(accumulatedToolArgs)).not.toThrow();
				expect(toolCall.arguments).not.toBeUndefined();
				expect((toolCall.arguments as any).a).toBe(15);
				expect((toolCall.arguments as any).b).toBe(27);
				expect((toolCall.arguments as any).operation).oneOf(["add", "subtract", "multiply", "divide"]);
			}
		}
		if (event.type === "toolcall.final") {
			hasToolFinal = true;
			const toolCall = event.toolCall;
			expectValidToolCall(toolCall);
			expect(toolCall.name).toBe("math_operation");
			if (callId) expect(toolCall.callID).toBe(callId);
			expect((toolCall.arguments as any).a).toBe(15);
			expect((toolCall.arguments as any).b).toBe(27);
			expect((toolCall.arguments as any).operation).oneOf(["add", "subtract", "multiply", "divide"]);
		}
	}

	expect(hasToolFinal).toBe(true);
	if (hasToolStart || hasToolDelta || hasToolEnd) {
		expect(hasToolStart).toBe(true);
		expect(hasToolDelta).toBe(true);
		expect(hasToolEnd).toBe(true);
	}

	const response = await s.result();
	const toolCalls = expectAssistantToolUseMessage(response);
	expect(toolCalls.some((toolCall) => toolCall.name === "math_operation")).toBe(true);
}

async function handleThinking<TOptions extends Protocol.CommonOptions>(model: StreamableModel, options: TOptions) {
	let thinkingStarted = false;
	let thinkingChunks = "";
	let thinkingCompleted = false;

	const context: Message.Context = {
		systemPrompt: "You are helpful assistant",
		messages: [
			Message.createUserMessage({
				role: "user",
				time: {
					created: Date.now(),
				},
				parts: [
					{
						type: "text",
						text: `Think long and hard about ${(Math.random() * 255) | 0} + 27. Think step by step. Then output the result.`,
					},
				],
			}),
		],
	};

	const s = stream(model, context, options);

	for await (const event of s) {
		if (event.type === "thinking.start") {
			thinkingStarted = true;
		} else if (event.type === "thinking.delta") {
			thinkingChunks += event.delta;
		} else if (event.type === "thinking.end") {
			thinkingCompleted = true;
		}
	}

	const response = await s.result();
	const thinkingBlocks = response.parts.filter((part): part is Message.ThinkingContent => part.type === "thinking");
	const hasThinkingContent =
		thinkingChunks.length > 0 ||
		thinkingBlocks.some((block) => block.thinking.length > 0 || Boolean(block.thinkingSignature));

	expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("stop");
	expect(thinkingStarted).toBe(true);
	expect(hasThinkingContent).toBe(true);
	expect(thinkingCompleted).toBe(true);
	expect(thinkingBlocks.length).toBeGreaterThan(0);
}

async function handleStreaming<TOptions extends Protocol.CommonOptions>(model: StreamableModel, options: TOptions) {
	let textStarted = false;
	let textChunks = "";
	let textCompleted = false;

	const context: Message.Context = {
		systemPrompt: "You are helpful assistant",
		messages: [
			Message.createUserMessage({
				role: "user",
				time: {
					created: Date.now(),
				},
				parts: [
					{
						type: "text",
						text: "Count from 1 to 3",
					},
				],
			}),
		],
	};

	const s = stream(model, context, options);

	for await (const event of s) {
		if (event.type === "text.start") {
			textStarted = true;
		} else if (event.type === "text.delta") {
			textChunks += event.delta;
		} else if (event.type === "text.end") {
			textCompleted = true;
		}
	}

	const response = await s.result();

	expect(textStarted).toBe(true);
	expect(textChunks.length).toBeGreaterThan(0);
	expect(textCompleted).toBe(true);
	expect(response.parts.some((b) => b.type === "text")).toBeTruthy();
}

async function handleMultiTurn<TOptions extends Protocol.CommonOptions>(model: StreamableModel, options: TOptions) {
	const context: Message.Context = {
		systemPrompt: "You are a helpful assistant that can use tools to answer questions.",
		messages: [
			Message.createUserMessage({
				role: "user",
				time: {
					created: Date.now(),
				},
				parts: [
					{
						type: "text",
						text: "Think about this briefly, then calculate 42 * 17 and 453 + 434 using the math_operation tool.",
					},
				],
			}),
		],
		tools: [calculatorTool],
	};

	let allTextContent = "";
	let hasSeenThinking = false;
	let hasSeenToolCalls = false;
	const maxTurns = 5; // Prevent infinite loops

	for (let turn = 0; turn < maxTurns; turn++) {
		const response = await stream.complete(model, context, options);
		expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");

		// Process content blocks
		let hasPendingToolCalls = false;
		for (const [partIndex, block] of response.parts.entries()) {
			if (block.type === "text") {
				allTextContent += block.text;
			} else if (block.type === "thinking") {
				hasSeenThinking = true;
			} else if (block.type === "toolCall") {
				hasSeenToolCalls = true;

				// Process the tool call
				expect(block.name).toBe("math_operation");
				expect(block.callID).toBeTruthy();
				expect(block.arguments).toBeTruthy();

				if (block.status !== "pending" && block.status !== "running") continue;

				hasPendingToolCalls = true;
				const a = Number(block.arguments.a);
				const b = Number(block.arguments.b);
				const operation = String(block.arguments.operation);
				let result: number;
				switch (operation) {
					case "add":
						result = a + b;
						break;
					case "multiply":
						result = a * b;
						break;
					default:
						result = 0;
				}

				const completedToolCall: Message.ToolCallCompletedPart = {
					...block,
					status: "completed",
					result: {
						content: [{ type: "text", text: `${result}` }],
						isError: false,
					},
					time: {
						start: block.time.start,
						end: Date.now(),
					},
				};
				response.parts[partIndex] = completedToolCall;
			}
		}

		// Add the assistant response, including completed tool results, to context
		context.messages.push(response);

		if (response.stopReason === "stop" || !hasPendingToolCalls) {
			break;
		}
	}

	// Verify we got either thinking content or tool calls (or both)
	expect(hasSeenThinking || hasSeenToolCalls).toBe(true);

	// The accumulated text should reference both calculations
	expect(allTextContent).toBeTruthy();
	expect(allTextContent.includes("714")).toBe(true);
	expect(allTextContent.includes("887")).toBe(true);
}

async function handleImage<TOptions extends Protocol.CommonOptions>(model: StreamableModel, options: TOptions) {
	// Read the test image
	const imagePath = fileURLToPath(new URL("../data/red-circle.png", import.meta.url));
	const base64Image = readFileSync(imagePath).toString("base64");

	const context: Message.Context = {
		systemPrompt: "You are helpful assistant that uses tools when asked",
		messages: [
			Message.createUserMessage({
				role: "user",
				time: {
					created: Date.now(),
				},
				parts: [
					{
						type: "text",
						text: "What do you see in this image? Please describe the shape (circle, rectangle, square, triangle, ...) and color (red, blue, green, ...). You MUST reply in English.",
					},
					{
						type: "image",
						data: base64Image,
						mimeType: "image/png",
					},
				],
			}),
		],
		tools: [calculatorTool],
	};

	const response = await stream.complete(model, context, options);

	// Check the response mentions red and circle
	expect(response.parts.length > 0).toBeTruthy();
	const textContent = response.parts.find((b) => b.type === "text");
	if (textContent && textContent.type === "text") {
		const lowerContent = textContent.text.toLowerCase();
		expect(lowerContent).toContain("red");
		expect(lowerContent).toContain("circle");
	}
}

describe("Generate E2E Tests", () => {
	// ── Anthropic E2E tests ──

	describeIfAnthropic("Anthropic provider (claude-haiku-4-5-20251001)", () => {
		const options = anthropicOptions();

		it("should resolve appropriate protocol", async () => {
			const model = await getAnthropicModel();
			expect(model.protocol).toBe(Model.KnownProviderEnum.anthropic);
		});

		it("should complete basic text generation", { retry: 3, timeout: 30000 }, async () => {
			const model = await getAnthropicModel();
			await basicTextGeneration(model, options);
		});

		it("should handle tool calling", { retry: 3, timeout: 30000 }, async () => {
			const model = await getAnthropicModel();
			await handleToolCall(model, options);
		});

		it("should handle streaming", { retry: 3, timeout: 30000 }, async () => {
			const model = await getAnthropicModel();
			await handleStreaming(model, options);
		});

		it("should handle thinking", { retry: 3, timeout: 30000 }, async () => {
			const model = await getAnthropicModel();
			// Use reasoning option to enable thinking (maps to anthropic provider thinking config)
			await handleThinking(model, { ...options, reasoning: "high" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3, timeout: 60000 }, async () => {
			const model = await getAnthropicModel();
			await handleMultiTurn(model, { ...options, reasoning: "high" });
		});

		it("should handle image input", { retry: 3, timeout: 30000 }, async (ctx) => {
			const model = await getAnthropicModel();
			if (!model.input.includes("image")) ctx.skip();
			await handleImage(model, options);
		});
	});

	// ── OpenAI E2E tests (gpt-4o-mini, non-reasoning) ──

	describeIfOpenAI("OpenAI provider (gpt-4o-mini)", () => {
		const options = openaiOptions();

		it("should resolve appropriate protocol", async () => {
			const model = await getOpenAIModel();
			expect(model.protocol).toBe(Model.KnownProviderEnum.openai);
		});

		it("should complete basic text generation", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIModel();
			await basicTextGeneration(model, options);
		});

		it("should handle tool calling", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIModel();
			await handleToolCall(model, options);
		});

		it("should handle streaming", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIModel();
			await handleStreaming(model, options);
		});

		it("should handle image input", { retry: 3, timeout: 30000 }, async (ctx) => {
			const model = await getOpenAIModel();
			if (!model.input.includes("image")) ctx.skip();
			await handleImage(model, options);
		});
	});

	// ── OpenAI reasoning model E2E tests (gpt-5.4) ──

	describeIfOpenAI("OpenAI reasoning provider (gpt-5.4)", () => {
		const options = openaiOptions();

		it("should resolve appropriate protocol", async () => {
			const model = await getOpenAIModel("gpt-5.4");
			expect(model.protocol).toBe(Model.KnownProviderEnum.openai);
		});

		it("should complete basic text generation", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIModel("gpt-5.4");
			await basicTextGeneration(model, options);
		});

		it("should handle tool calling", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIModel("gpt-5.4");
			await handleToolCall(model, options);
		});

		it("should handle streaming", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIModel("gpt-5.4");
			await handleStreaming(model, options);
		});

		it("should handle image input", { retry: 3, timeout: 30000 }, async (ctx) => {
			const model = await getOpenAIModel("gpt-5.4");
			if (!model.input.includes("image")) ctx.skip();
			await handleImage(model, options);
		});
	});

	// ── OpenAI Codex E2E tests (ChatGPT OAuth, gpt-5.4) ──

	describeIfOpenAICodex("OpenAI Codex provider (gpt-5.4)", () => {
		const options = openaiCodexOptions();

		it("should resolve appropriate protocol", async () => {
			const model = await getOpenAICodexModel();
			expect(model.protocol).toBe(Model.KnownProviderEnum.openaiCodex);
		});

		it("should complete basic text generation", { retry: 3, timeout: 60000 }, async () => {
			const model = await getOpenAICodexModel();
			await basicTextGeneration(model, options);
		});

		it("should handle tool calling", { retry: 3, timeout: 60000 }, async () => {
			const model = await getOpenAICodexModel();
			await handleToolCall(model, options);
		});

		it("should handle streaming", { retry: 3, timeout: 60000 }, async () => {
			const model = await getOpenAICodexModel();
			await handleStreaming(model, options);
		});

		it("should handle thinking", { retry: 3, timeout: 60000 }, async () => {
			const model = await getOpenAICodexModel();
			await handleThinking(model, { ...options, reasoning: "high" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3, timeout: 120000 }, async () => {
			const model = await getOpenAICodexModel();
			await handleMultiTurn(model, { ...options, reasoning: "medium" });
		});

		it("should handle image input", { retry: 3, timeout: 60000 }, async (ctx) => {
			const model = await getOpenAICodexModel();
			if (!model.input.includes("image")) ctx.skip();
			await handleImage(model, options);
		});
	});

	// ── OpenRouter E2E ──

	describeIfOpenRouter("OpenRouter provider (deepseek/deepseek-v4-flash)", () => {
		const options = openrouterOptions();

		it("should resolve appropriate protocol", async () => {
			const model = await getOpenRouterModel();
			expect(model.protocol).toBe(Model.KnownProviderEnum.openrouter);
		});

		it("should complete basic text generation", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenRouterModel();
			await basicTextGeneration(model, options);
		});

		it("should handle tool calling", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenRouterModel();
			await handleToolCall(model, options);
		});

		it("should handle streaming", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenRouterModel();
			await handleStreaming(model, options);
		});

		it("should handle image input", { retry: 3, timeout: 30000 }, async (ctx) => {
			const model = await getOpenRouterModel();
			if (!model.input.includes("image")) ctx.skip();
			await handleImage(model, options);
		});
	});
});
