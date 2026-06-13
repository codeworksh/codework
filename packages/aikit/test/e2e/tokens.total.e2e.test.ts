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
import { describe, expect, it } from "vite-plus/test";
import { Protocol } from "../../src/llm/protocol";
import { Message } from "../../src/message/message";
import { complete } from "../../src/stream";
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
	openaiCodexOptions,
	openaiOptions,
	openrouterOptions,
	type StreamableModel,
} from "../utils/llm";

type Usage = Message.AssistantMessage["usage"];
type StreamOptionsWithExtras = Protocol.CommonOptions & Record<string, unknown>;

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
	model: StreamableModel,
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

describe("totalTokens field", () => {
	// ── Anthropic ---
	describeIfAnthropic("Anthropic", () => {
		it(
			"claude-sonnet-4 - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const model = await getAnthropicModel("claude-sonnet-4-20250514");
				const options = anthropicOptions({ cacheRetention: "short" });

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
				const model = await getOpenAIModel();
				const options = openaiOptions();

				console.log(`\nOpenAI / ${model.id}:`);
				const { first, second } = await testTotalTokensWithCache(model, options);

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});

	// --- OpenAI Codex ---
	describeIfOpenAICodex("OpenAI Codex", () => {
		it("gpt-5.4 - should return totalTokens equal to sum of components", { retry: 3, timeout: 120000 }, async () => {
			const model = await getOpenAICodexModel();
			const options = openaiCodexOptions({ sessionId: `aikit-e2e-${Date.now()}` });

			console.log(`\nOpenAI Codex / ${model.id}:`);
			const { first, second } = await testTotalTokensWithCache(model, options);

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	// --- OpenRouter ---
	describeIfOpenRouter("OpenRouter", () => {
		it(
			"deepseek/deepseek-v4-flash - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const model = await getOpenRouterModel();
				const options = openrouterOptions();

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
