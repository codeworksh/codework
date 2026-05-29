import "./utils/env";

import { describe, expect, it } from "vite-plus/test";
import { llm } from "../src/llm";
import type { AnthropicOptions, OpenAIOptions } from "../src/llm/options";
import { Message } from "../src/message/message";
import { Model } from "../src/model/model";
import { stream } from "../src/stream";

const describeIfAnthropic = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;
const describeIfOpenAI = process.env.OPENAI_API_KEY ? describe : describe.skip;

function makeContext(): Message.Context {
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
						text: `What is ${(Math.random() * 100) | 0} + ${(Math.random() * 100) | 0}? Give the final answer only.`,
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

async function getOpenAIReasoningModel(): Promise<Model.TModel<typeof Model.KnownProviderEnum.openai>> {
	const model = await llm("openai", "o3-mini");
	assertOpenAIModel(model);
	return model;
}

function expectXhighSupport(model: Model.Info, clamped: Model.ThinkingLevel) {
	expect(Model.getSupportedThinkingLevels(model)).not.toContain("xhigh");
	expect(Model.clampThinkingLevel(model, "xhigh")).toBe(clamped);
}

async function completeWithXhigh(model: Model.Info, options: AnthropicOptions | OpenAIOptions) {
	const response = await stream.complete(model as never, makeContext(), {
		maxTokens: 256,
		...options,
		reasoning: "xhigh",
		thinkingBudgets: {
			high: 1024,
			xhigh: 1024,
		},
	} as never);

	expect(response.stopReason, response.errorMessage).toBe("stop");
	expect(getText(response).length).toBeGreaterThan(0);
}

describe("xhigh reasoning", () => {
	describeIfOpenAI("openai provider (gpt-4o-mini)", () => {
		const options: OpenAIOptions = {
			apiKey: process.env.OPENAI_API_KEY,
		};

		it("should ignore xhigh for a non-reasoning model", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIModel();
			expectXhighSupport(model, "off");
			await completeWithXhigh(model, options);
		});
	});

	describeIfOpenAI("openai reasoning provider (o3-mini)", () => {
		const options: OpenAIOptions = {
			apiKey: process.env.OPENAI_API_KEY,
		};

		it("should clamp unsupported xhigh to high", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIReasoningModel();
			expectXhighSupport(model, "high");
			await completeWithXhigh(model, options);
		});
	});

	describeIfAnthropic("anthropic provider (claude-sonnet-4-20250514)", () => {
		const options: AnthropicOptions = {
			apiKey: process.env.ANTHROPIC_API_KEY,
		};

		it("should clamp unsupported xhigh to high", { retry: 3, timeout: 30000 }, async () => {
			const model = await getAnthropicModel();
			expectXhighSupport(model, "high");
			await completeWithXhigh(model, options);
		});
	});
});
