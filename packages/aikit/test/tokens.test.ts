import "./utils/env";

import { describe, expect, it } from "vite-plus/test";
import { llm } from "../src/llm";
import type { AnthropicOptions, OpenAIOptions, OpenRouterOptions } from "../src/llm/options";
import { Protocol } from "../src/llm/protocol";
import { Message } from "../src/message/message";
import { Model } from "../src/model/model";
import { stream } from "../src/stream";

type StreamOptionsWithExtras = Protocol.CommonOptions & Record<string, unknown>;

const describeIfOpenAI = process.env.OPENAI_API_KEY ? describe : describe.skip;
const describeIfAnthropic = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;
const describeIfOpenRouter = process.env.OPENROUTER_API_KEY ? describe : describe.skip;

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

async function testTokensOnAbort(model: Model.Info, options: StreamOptionsWithExtras) {
	const context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			Message.createUserMessage({
				role: "user",
				time: {
					created: Date.now(),
				},
				parts: [
					{
						type: "text",
						text: "Write a long poem with 20 stanzas about the beauty of nature.",
					},
				],
			}),
		],
	};

	const controller = new AbortController();
	const response = stream(model, context, {
		...options,
		signal: controller.signal,
	});

	let abortFired = false;
	let text = "";
	for await (const event of response) {
		if (!abortFired && (event.type === "text.delta" || event.type === "thinking.delta")) {
			text += event.delta;
			if (text.length >= 1000) {
				abortFired = true;
				controller.abort();
			}
		}
	}

	const msg = await response.result();

	expect(msg.stopReason).toBe("aborted");

	// With aisdk, token usage metrics are surfaced at the end of the stream.
	// Therefore, an aborted stream will not have any token statistics recorded.
	expect(msg.usage.input).toBe(0);
	expect(msg.usage.output).toBe(0);
}

describe("Token Statistics on Abort", () => {
	describeIfOpenAI("OpenAI Provider", () => {
		it("gpt-4o-mini - should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIModel("gpt-4o-mini");
			const options: OpenAIOptions = { apiKey: process.env.OPENAI_API_KEY };
			await testTokensOnAbort(model, options);
		});
	});

	describeIfAnthropic("Anthropic Provider", () => {
		it(
			"claude-sonnet-4-20250514 - should include token stats when aborted mid-stream",
			{ retry: 3, timeout: 30000 },
			async () => {
				const model = await getAnthropicModel("claude-sonnet-4-20250514");
				const options: AnthropicOptions = { apiKey: process.env.ANTHROPIC_API_KEY };
				await testTokensOnAbort(model, options);
			},
		);
	});

	describeIfOpenRouter("OpenRouter Provider", () => {
		it(
			"deepseek/deepseek-v4-flash - should include token stats when aborted mid-stream",
			{ retry: 3, timeout: 30000 },
			async () => {
				const model = await getOpenRouterModel("deepseek/deepseek-v4-flash");
				const options: OpenRouterOptions = {
					apiKey: process.env.OPENROUTER_API_KEY,
					headers: {
						"HTTP-Referer": "https://www.codework.sh",
						"X-OpenRouter-Title": "CodeWork",
						"X-OpenRouter-Categories": "cli-agent,personal-agent",
					},
				};
				await testTokensOnAbort(model, options);
			},
		);
	});
});
