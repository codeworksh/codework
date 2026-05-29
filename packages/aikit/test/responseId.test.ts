import "./utils/env";

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

async function expectResponseId(model: Model.Info, options: StreamOptionsWithExtras = {}) {
	const context: Message.Context = {
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
						text: "Reply with exactly: response id test",
					},
				],
			}),
		],
	};

	const response = await complete(model, context, options);

	expect(response.stopReason, response.errorMessage).not.toBe("error");
	expect(response.responseId).toBeTruthy();
	expect(typeof response.responseId).toBe("string");
}

function assertOpenAIModel(
	model: Model.Info | undefined,
): asserts model is Model.TModel<typeof Model.KnownProviderEnum.openai> {
	if (!model) {
		throw new Error("Expected Open AI model to be defined");
	}
	if (model.protocol !== Model.KnownProviderEnum.openai) {
		throw new Error(`Expected openai protocol, received ${model.protocol}`);
	}
}

async function getOpenAIModel(modelId: string): Promise<Model.TModel<typeof Model.KnownProviderEnum.openai>> {
	const model = await llm("openai", modelId);
	assertOpenAIModel(model);
	return model;
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

async function getAnthropicModel(modelId: string): Promise<Model.TModel<typeof Model.KnownProviderEnum.anthropic>> {
	const model = await llm("anthropic", modelId);
	assertAnthropicModel(model);
	return model;
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

async function getOpenRouterModel(modelId: string): Promise<Model.TModel<typeof Model.KnownProviderEnum.openrouter>> {
	const model = await llm("openrouter", modelId);
	assertOpenRouterModel(model);
	return model;
}

describe("responseId E2E Tests", () => {
	describeIfOpenAI("OpenAI Provider", () => {
		it("should expose responseId", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIModel("gpt-4o-mini");
			const options: OpenAIOptions = { apiKey: process.env.OPENAI_API_KEY };
			await expectResponseId(model, options);
		});
	});

	describeIfAnthropic("Anthropic Provider", () => {
		it("should expose responseId", { retry: 3, timeout: 30000 }, async () => {
			const model = await getAnthropicModel("claude-sonnet-4-20250514");
			const options: AnthropicOptions = { apiKey: process.env.ANTHROPIC_API_KEY };
			await expectResponseId(model, options);
		});
	});

	describeIfOpenRouter("OpenRouter Provider", () => {
		it("should expose responseId", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenRouterModel("deepseek/deepseek-v4-flash");
			const options: OpenRouterOptions = {
				apiKey: process.env.OPENROUTER_API_KEY,
				headers: {
					"HTTP-Referer": "https://www.codework.sh",
					"X-OpenRouter-Title": "CodeWork",
					"X-OpenRouter-Categories": "cli-agent,personal-agent",
				},
			};
			await expectResponseId(model, options);
		});
	});
});
