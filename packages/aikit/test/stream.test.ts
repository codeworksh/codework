import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { Agent } from "../src/agent/agent";
import { llm } from "../src/llm";
import { Message } from "../src/message/message";
import { ModelCatalog } from "../src/model/catalog";
import { Model } from "../src/model/model";
import { Stream } from "../src/provider/stream";
import { complete, completeSimple, stream, streamSimple } from "../src/stream";
import { validateToolArguments } from "../src/utils/validation";
import { expectAssistantToolUseMessage, expectValidToolCall } from "./utils/message";
import { ROOT_MODELS_PATH } from "./utils/paths";
import { calculatorTool } from "./utils/tools";

function contextFor(prompt: string): Message.Context {
	return {
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
						text: prompt,
					},
				],
			}),
		],
	};
}

function getText(message: Message.AssistantMessage): string {
	return message.parts
		.filter((part): part is Message.TextContent => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function userMessage(text: string): Message.UserMessage {
	return Message.createUserMessage({
		role: "user",
		time: {
			created: Date.now(),
		},
		parts: [
			{
				type: "text",
				text,
			},
		],
	});
}

function toToolExecution(toolCall: Message.ToolCall): Agent.ToolCallInFlight {
	return {
		callID: toolCall.callID,
		name: toolCall.name,
		rawArgs: toolCall.arguments,
	};
}

async function getAnthropicModel() {
	const model = await llm("anthropic", "claude-haiku-4-5-20251001");
	expect(model).toBeDefined();
	return model!;
}

describe("stream", () => {
	it("registers built-in protocol providers into the Stream registry", () => {
		const provider = Stream.getProtocolProvider(Model.KnownProtocolEnum.anthropicMessages);

		expect(provider).toBeDefined();
		expect(provider?.protocol).toBe(Model.KnownProtocolEnum.anthropicMessages);
		expect(
			Stream.getApiProviders().some((entry) => entry.protocol === Model.KnownProtocolEnum.anthropicMessages),
		).toBe(true);
	});

	it("exposes the public callable helpers from the facade module", () => {
		expect(stream.complete).toBe(complete);
		expect(stream.simple).toBe(streamSimple);
		expect(stream.completeSimple).toBe(completeSimple);
		expect(stream.resolveProtocolProvider).toBe(Stream.resolveProtocolProvider);
	});

	it("throws a named error when a protocol provider is not registered", () => {
		const registeredProviders = Stream.getApiProviders();

		try {
			Stream.clearProtocolProviders();
			stream.resolveProtocolProvider({
				protocol: Model.KnownProtocolEnum.anthropicMessages,
			} as unknown as Model.Value);
			throw new Error("expected resolveProtocolProvider() to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(Stream.ProtocolProviderNotFoundError);
			expect((error as Stream.ProtocolProviderNotFoundError).data.protocol).toBe(
				Model.KnownProtocolEnum.anthropicMessages,
			);
		} finally {
			for (const provider of registeredProviders) {
				Stream.registerProtocolProvider(provider, `test-restore-${provider.protocol}`);
			}
		}
	});
});

const describeIfAnthropic = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;

describeIfAnthropic("anthropic stream", () => {
	const originalModelsPath = process.env.CODEWORK_AIKIT_MODELS_PATH;

	beforeEach(() => {
		process.env.CODEWORK_AIKIT_MODELS_PATH = ROOT_MODELS_PATH;
		ModelCatalog.modelsDevData.reset();
		Model.registry.reset();
	});

	afterEach(() => {
		process.env.CODEWORK_AIKIT_MODELS_PATH = originalModelsPath;
		ModelCatalog.modelsDevData.reset();
		Model.registry.reset();
	});

	it("completes basic text generation", async () => {
		const model = await getAnthropicModel();
		const response = await stream.complete(model, contextFor("Reply with exactly: Hello test successful"), {
			apiKey: process.env.ANTHROPIC_API_KEY,
		});

		expect(response.role).toBe("assistant");
		expect(response.provider.id).toBe("anthropic");
		expect(response.model).toBe(model.id);
		expect(response.usage.input + response.usage.cacheRead).toBeGreaterThan(0);
		expect(response.usage.output).toBeGreaterThan(0);
		expect(response.errorMessage).toBeFalsy();
		expect(getText(response)).toContain("Hello test successful");
	}, 30000);

	it("streams text events", async () => {
		const model = await getAnthropicModel();
		const s = stream(model, contextFor("Count from 1 to 3 in plain text"), {
			apiKey: process.env.ANTHROPIC_API_KEY,
		});

		let textStarted = false;
		let textChunks = "";
		let textCompleted = false;

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
		expect(response.role).toBe("assistant");
		expect(response.errorMessage).toBeFalsy();
		expect(getText(response).length).toBeGreaterThan(0);
	}, 30000);

	it("filters tool calls without corresponding tool results", async () => {
		const model = await getAnthropicModel();
		const context: Message.Context = {
			systemPrompt: "You are a helpful assistant. Use the calculator tool when asked to perform calculations.",
			messages: [userMessage("Please calculate 25 * 18 using the calculator tool.")],
			tools: [calculatorTool],
		};

		const firstResponse = await stream.complete(model, context, {
			apiKey: process.env.ANTHROPIC_API_KEY,
		});
		context.messages.push(firstResponse);

		const toolCalls = expectAssistantToolUseMessage(firstResponse);

		const args = validateToolArguments(calculatorTool, toToolExecution(toolCalls[0]!));
		expect(args.expression).toContain("25");
		expect(args.expression).toContain("18");

		context.messages.push(userMessage("Never mind, just tell me what is 2+2?"));

		const secondResponse = await stream.complete(model, context, {
			apiKey: process.env.ANTHROPIC_API_KEY,
		});

		expect(secondResponse.stopReason).not.toBe("error");
		expect(secondResponse.parts.length).toBeGreaterThan(0);

		const secondText = getText(secondResponse);
		const secondToolCalls = secondResponse.parts.filter((part) => part.type === "toolCall").length;
		expect(secondToolCalls || secondText.length).toBeGreaterThan(0);
		expect(["stop", "toolUse"]).toContain(secondResponse.stopReason);
	}, 30000);

	it("streams tool call events with validated arguments", async () => {
		const model = await getAnthropicModel();
		const context: Message.Context = {
			systemPrompt: "You are a helpful assistant. Always use the calculator tool for arithmetic requests.",
			messages: [userMessage("Use the calculator tool for `25 * 18`. Do not solve it yourself.")],
			tools: [calculatorTool],
		};
		const s = stream(model, context, {
			apiKey: process.env.ANTHROPIC_API_KEY,
		});

		let toolCallStarted = false;
		let toolCallEnded = false;
		let toolCallDelta = "";
		let finalToolCall: Message.ToolCall | undefined;

		for await (const event of s) {
			if (event.type === "toolcall.start") {
				toolCallStarted = true;
			} else if (event.type === "toolcall.delta") {
				toolCallDelta += event.delta;
			} else if (event.type === "toolcall.end") {
				toolCallEnded = true;
				finalToolCall = event.toolCall;
			}
		}

		const response = await s.result();
		const responseToolCalls = response.parts.filter((part): part is Message.ToolCall => part.type === "toolCall");

		expect(toolCallStarted).toBe(true);
		expect(toolCallEnded).toBe(true);
		expect(toolCallDelta.length).toBeGreaterThan(0);
		expectAssistantToolUseMessage(response);
		expect(finalToolCall).toBeDefined();
		expectValidToolCall(finalToolCall!, "pending");
		expect(finalToolCall?.name).toBe("calculator");
		expect(responseToolCalls.some((toolCall) => toolCall.callID === finalToolCall?.callID)).toBe(true);

		const args = validateToolArguments(calculatorTool, toToolExecution(finalToolCall!));
		expect(args.expression).toContain("25");
		expect(args.expression).toContain("18");
	}, 30000);
});
