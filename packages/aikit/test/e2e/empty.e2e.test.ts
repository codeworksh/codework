import { describe, expect, it } from "vite-plus/test";
import * as Message from "../../src/message/message.ts";
import { complete } from "../../src/stream.ts";
import { makeAssistantMessage, makeUsage } from "../utils/fixtures.ts";
import {
	ANTHROPIC_E2E_MODELS,
	anthropicOptions,
	describeIfAnthropic,
	describeIfOpenAI,
	describeIfOpenAICodex,
	OPENAI_CODEX_E2E_MODELS,
	OPENAI_E2E_MODELS,
	describeIfOpenRouter,
	OPENROUTER_E2E_MODELS,
	getAnthropicModel,
	getOpenAICodexModel,
	getOpenAIModel,
	getOpenRouterModel,
	openaiCodexOptions,
	openaiOptions,
	openrouterOptions,
	type StreamableModel,
} from "../utils/llm.ts";

type SupportedOptions = Record<string, unknown>;

function createUserMessage(parts: Message.UserMessage["parts"]): Message.UserMessage {
	return Message.createUserMessage({
		role: "user",
		parts,
		time: { created: Date.now() },
	});
}

// Empty input is allowed to be rejected by the provider, but it must surface as
// a structured error response, never as a thrown exception.
function expectGracefulResponse(response: Message.AssistantMessage): void {
	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeTruthy();
	} else {
		expect(response.stopReason).toBe("stop");
		expect(response.errorMessage).toBeFalsy();
		expect(response.parts).toBeDefined();
	}
}

async function testEmptyMessage(model: StreamableModel, options: SupportedOptions = {}) {
	const context: Message.Context = {
		messages: [createUserMessage([])],
	};

	expectGracefulResponse(await complete(model, context, options));
}

async function testEmptyStringMessage(model: StreamableModel, options: SupportedOptions = {}) {
	const context: Message.Context = {
		messages: [createUserMessage([{ type: "text", text: "" }])],
	};

	expectGracefulResponse(await complete(model, context, options));
}

async function testWhitespaceOnlyMessage(model: StreamableModel, options: SupportedOptions = {}) {
	const context: Message.Context = {
		messages: [createUserMessage([{ type: "text", text: "   \n\t  " }])],
	};

	expectGracefulResponse(await complete(model, context, options));
}

async function testEmptyAssistantMessage(model: StreamableModel, options: SupportedOptions = {}) {
	const emptyAssistant = makeAssistantMessage(model, {
		usage: makeUsage({ input: 10, totalTokens: 10 }),
	});

	const context: Message.Context = {
		messages: [
			createUserMessage([{ type: "text", text: "Hello, how are you?" }]),
			emptyAssistant,
			createUserMessage([{ type: "text", text: "Please respond this time." }]),
		],
	};

	const response = await complete(model, context, options);

	expectGracefulResponse(response);
	if (response.stopReason !== "error") {
		expect(response.parts.length).toBeGreaterThan(0);
	}
}

describe("AI Providers Empty Message Tests", () => {
	describeIfOpenAI.each(OPENAI_E2E_MODELS)("OpenAI Provider Empty Messages (%s)", (modelId) => {
		const options = openaiOptions();

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(await getOpenAIModel(modelId), options);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(await getOpenAIModel(modelId), options);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(await getOpenAIModel(modelId), options);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(await getOpenAIModel(modelId), options);
		});
	});

	describeIfAnthropic.each(ANTHROPIC_E2E_MODELS)("Anthropic Provider Empty Messages (%s)", (modelId) => {
		const options = anthropicOptions();

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(await getAnthropicModel(modelId), options);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(await getAnthropicModel(modelId), options);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(await getAnthropicModel(modelId), options);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(await getAnthropicModel(modelId), options);
		});
	});

	describeIfOpenAICodex.each(OPENAI_CODEX_E2E_MODELS)("OpenAI Codex Provider Empty Messages (%s)", (modelId) => {
		const options = openaiCodexOptions();

		it("should handle empty content array", { retry: 3, timeout: 60_000 }, async () => {
			await testEmptyMessage(await getOpenAICodexModel(modelId), options);
		});

		it("should handle empty string content", { retry: 3, timeout: 60_000 }, async () => {
			await testEmptyStringMessage(await getOpenAICodexModel(modelId), options);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 60_000 }, async () => {
			await testWhitespaceOnlyMessage(await getOpenAICodexModel(modelId), options);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 60_000 }, async () => {
			await testEmptyAssistantMessage(await getOpenAICodexModel(modelId), options);
		});
	});

	describeIfOpenRouter.each(OPENROUTER_E2E_MODELS)("OpenRouter Provider Empty Messages (%s)", (modelId) => {
		const options = openrouterOptions();

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(await getOpenRouterModel(modelId), options);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(await getOpenRouterModel(modelId), options);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(await getOpenRouterModel(modelId), options);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(await getOpenRouterModel(modelId), options);
		});
	});
});
