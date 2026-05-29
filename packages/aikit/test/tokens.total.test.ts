/**
 * Test totalTokens field across all supported providers.
 *
 * totalTokens represents the total number of tokens processed by the LLM,
 * including input (with cache) and output (with thinking). This is the
 * base for calculating context size for the next request.
 *
 * - OpenAI: Computed as input + output + cacheRead + cacheWrite
 * - Anthropic: Computed as input + output + cacheRead + cacheWrite
 * - OpenRouter: Computed as input + output + cacheRead + cacheWrite
 */
import "./utils/env";

import { describe, expect, it } from "vite-plus/test";
import { llm } from "../src/llm";
import type { AnthropicOptions, OpenAIOptions, OpenRouterOptions } from "../src/llm/options";
import { Protocol } from "../src/llm/protocol";
import { Message } from "../src/message/message";
import { Model } from "../src/model/model";
import { complete } from "../src/stream";

type Usage = Message.AssistantMessage["usage"];
type StreamOptionsWithExtras = Protocol.CommonOptions & Record<string, unknown>;

const describeIfOpenAI = process.env.OPENAI_API_KEY ? describe : describe.skip;
const describeIfAnthropic = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;
const describeIfOpenRouter = process.env.OPENROUTER_API_KEY ? describe : describe.skip;

// Generate a long system prompt to trigger caching (>2k bytes for most providers)
const LONG_SYSTEM_PROMPT = `You are a helpful assistant. Be concise in your responses.

Here is some additional context that makes this system prompt long enough to trigger caching:

${Array(50)
	.fill(
		"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.",
	)
	.join("\n\n")}

Remember: Always be helpful and concise.`;

function createTextMessage(text: string): Message.UserMessage {
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

async function testTotalTokensWithCache(
	model: Model.Info,
	options: StreamOptionsWithExtras = {},
): Promise<{ first: Usage; second: Usage }> {
	// First request - no cache
	const context1: Message.Context = {
		systemPrompt: LONG_SYSTEM_PROMPT,
		messages: [createTextMessage("What is 2 + 2? Reply with just the number.")],
	};

	const response1 = await complete(model, context1, options);
	expect(response1.stopReason, response1.errorMessage).toBe("stop");

	// Second request - should trigger cache read (same system prompt, add conversation)
	const context2: Message.Context = {
		systemPrompt: LONG_SYSTEM_PROMPT,
		messages: [...context1.messages, response1, createTextMessage("What is 3 + 3? Reply with just the number.")],
	};

	const response2 = await complete(model, context2, options);
	expect(response2.stopReason, response2.errorMessage).toBe("stop");

	return { first: response1.usage, second: response2.usage };
}

function logUsage(label: string, usage: Usage) {
	const computed = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	console.log(`  ${label}:`);
	console.log(
		`    input: ${usage.input}, output: ${usage.output}, cacheRead: ${usage.cacheRead}, cacheWrite: ${usage.cacheWrite}`,
	);
	console.log(`    totalTokens: ${usage.totalTokens}, computed: ${computed}`);
}

function assertTotalTokensEqualsComponents(usage: Usage) {
	const computed = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	expect(usage.totalTokens).toBe(computed);
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

async function getAnthropicModel(modelId: string): Promise<Model.TModel<typeof Model.KnownProviderEnum.anthropic>> {
	const model = await llm("anthropic", modelId);
	assertAnthropicModel(model);
	return model;
}

async function getOpenAIModel(modelId: string): Promise<Model.TModel<typeof Model.KnownProviderEnum.openai>> {
	const model = await llm("openai", modelId);
	assertOpenAIModel(model);
	return model;
}

async function getOpenRouterModel(modelId: string): Promise<Model.TModel<typeof Model.KnownProviderEnum.openrouter>> {
	const model = await llm("openrouter", modelId);
	assertOpenRouterModel(model);
	return model;
}

describe("totalTokens field", () => {
	// ── Anthropic ---
	describeIfAnthropic("Anthropic", () => {
		it(
			"claude-sonnet-4 - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const model = await getAnthropicModel("claude-sonnet-4-20250514");
				const options: AnthropicOptions = {
					apiKey: process.env.ANTHROPIC_API_KEY,
					cacheRetention: "short",
				};

				console.log(`\nAnthropic / ${model.id}:`);
				const { first, second } = await testTotalTokensWithCache(model, options);

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);

				// Anthropic should have cache activity
				const hasCache = second.cacheRead > 0 || second.cacheWrite > 0 || first.cacheWrite > 0;
				expect(hasCache).toBe(true);
			},
		);
	});

	// --- OpenAI ---
	describeIfOpenAI("OpenAI", () => {
		it(
			"gpt-4o-mini - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const model = await getOpenAIModel("gpt-4o-mini");
				const options: OpenAIOptions = {
					apiKey: process.env.OPENAI_API_KEY,
				};

				console.log(`\nOpenAI / ${model.id}:`);
				const { first, second } = await testTotalTokensWithCache(model, options);

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});

	// --- OpenRouter ---
	describeIfOpenRouter("OpenRouter", () => {
		it(
			"deepseek/deepseek-v4-flash - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
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

				console.log(`\nOpenRouter / ${model.id}:`);
				const { first, second } = await testTotalTokensWithCache(model, options);

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});
});
