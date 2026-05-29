import "./utils/env";

import { describe, expect, it } from "vite-plus/test";
import { llm } from "../src/llm";
import type { AnthropicOptions, OpenAIOptions, OpenRouterOptions } from "../src/llm/options";
import { Message } from "../src/message/message";
import { Model } from "../src/model/model";
import { complete } from "../src/stream";

const describeIfAnthropic = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;
const describeIfOpenAI = process.env.OPENAI_API_KEY ? describe : describe.skip;
const describeIfOpenRouter = process.env.OPENROUTER_API_KEY ? describe : describe.skip;

type SupportedOptions = Record<string, unknown>;

function createUserMessage(parts: Message.UserMessage["parts"]): Message.UserMessage {
	return Message.createUserMessage({
		role: "user",
		parts,
		time: { created: Date.now() },
	});
}

async function testEmptyMessage(model: Model.Info, options: SupportedOptions = {}) {
	const emptyMessage = createUserMessage([]);

	const context: Message.Context = {
		messages: [emptyMessage],
	};

	const response = await complete(model, context, options);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.parts).toBeDefined();
	}
}

async function testEmptyStringMessage(model: Model.Info, options: SupportedOptions = {}) {
	const context: Message.Context = {
		messages: [createUserMessage([{ type: "text", text: "" }])],
	};

	const response = await complete(model, context, options);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.parts).toBeDefined();
	}
}

async function testWhitespaceOnlyMessage(model: Model.Info, options: SupportedOptions = {}) {
	const context: Message.Context = {
		messages: [createUserMessage([{ type: "text", text: "   \n\t  " }])],
	};

	const response = await complete(model, context, options);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.parts).toBeDefined();
	}
}

async function testEmptyAssistantMessage(model: Model.Info, options: SupportedOptions = {}) {
	const emptyAssistant = Message.createAssistantMessage({
		role: "assistant",
		parts: [],
		protocol: model.protocol,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 10,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		time: {
			created: Date.now(),
			completed: Date.now(),
		},
	});

	const context: Message.Context = {
		messages: [
			createUserMessage([{ type: "text", text: "Hello, how are you?" }]),
			emptyAssistant,
			createUserMessage([{ type: "text", text: "Please respond this time." }]),
		],
	};

	const response = await complete(model, context, options);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.parts).toBeDefined();
		expect(response.parts.length).toBeGreaterThan(0);
	}
}

function assertModel(model: Model.Info | undefined): asserts model is Model.Info {
	if (!model) throw new Error("Expected model to be defined");
}

async function getAnthropicModel(): Promise<Model.Info> {
	const model = await llm("anthropic", "claude-sonnet-4-20250514");
	assertModel(model);
	return model;
}

async function getOpenAIModel(): Promise<Model.Info> {
	const model = await llm("openai", "gpt-4o-mini");
	assertModel(model);
	return model;
}

async function getOpenRouterModel(): Promise<Model.Info> {
	const model = await llm("openrouter", "deepseek/deepseek-v4-flash");
	assertModel(model);
	return model;
}

describe("AI Providers Empty Message Tests", () => {
	describeIfOpenAI("OpenAI Provider Empty Messages", () => {
		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(await getOpenAIModel(), { apiKey: process.env.OPENAI_API_KEY } satisfies OpenAIOptions);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(await getOpenAIModel(), {
				apiKey: process.env.OPENAI_API_KEY,
			} satisfies OpenAIOptions);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(await getOpenAIModel(), {
				apiKey: process.env.OPENAI_API_KEY,
			} satisfies OpenAIOptions);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(await getOpenAIModel(), {
				apiKey: process.env.OPENAI_API_KEY,
			} satisfies OpenAIOptions);
		});
	});

	describeIfAnthropic("Anthropic Provider Empty Messages", () => {
		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(await getAnthropicModel(), {
				apiKey: process.env.ANTHROPIC_API_KEY,
			} satisfies AnthropicOptions);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(await getAnthropicModel(), {
				apiKey: process.env.ANTHROPIC_API_KEY,
			} satisfies AnthropicOptions);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(await getAnthropicModel(), {
				apiKey: process.env.ANTHROPIC_API_KEY,
			} satisfies AnthropicOptions);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(await getAnthropicModel(), {
				apiKey: process.env.ANTHROPIC_API_KEY,
			} satisfies AnthropicOptions);
		});
	});

	describeIfOpenRouter("OpenRouter Provider Empty Messages", () => {
		const openRouterOptions: OpenRouterOptions = {
			apiKey: process.env.OPENROUTER_API_KEY,
			headers: {
				"HTTP-Referer": "https://www.codework.sh",
				"X-OpenRouter-Title": "CodeWork",
				"X-OpenRouter-Categories": "cli-agent,personal-agent",
			},
		};

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(await getOpenRouterModel(), openRouterOptions);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(await getOpenRouterModel(), openRouterOptions);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(await getOpenRouterModel(), openRouterOptions);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(await getOpenRouterModel(), openRouterOptions);
		});
	});
});
