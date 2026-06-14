import { describe, expect, it } from "vite-plus/test";
import { Protocol } from "../../src/llm/protocol";
import { Message } from "../../src/message/message";
import { stream } from "../../src/stream";
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

type StreamOptionsWithExtras = Protocol.CommonOptions & Record<string, unknown>;

async function testTokensOnAbort(model: StreamableModel, options: StreamOptionsWithExtras) {
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
		it(
			"gpt-4o-mini - should report zero token usage when aborted mid-stream",
			{ retry: 3, timeout: 30000 },
			async () => {
				const model = await getOpenAIModel();
				await testTokensOnAbort(model, openaiOptions());
			},
		);
	});

	describeIfAnthropic("Anthropic Provider", () => {
		it(
			"claude-sonnet-4-20250514 - should report zero token usage when aborted mid-stream",
			{ retry: 3, timeout: 30000 },
			async () => {
				const model = await getAnthropicModel("claude-sonnet-4-20250514");
				await testTokensOnAbort(model, anthropicOptions());
			},
		);
	});

	describeIfOpenRouter("OpenRouter Provider", () => {
		it(
			"deepseek/deepseek-v4-flash - should report zero token usage when aborted mid-stream",
			{ retry: 3, timeout: 30000 },
			async () => {
				const model = await getOpenRouterModel();
				await testTokensOnAbort(model, openrouterOptions());
			},
		);
	});

	describeIfOpenAICodex("OpenAI Codex Provider", () => {
		it("gpt-5.4 - should report zero token usage when aborted mid-stream", { retry: 3, timeout: 60000 }, async () => {
			const model = await getOpenAICodexModel();
			await testTokensOnAbort(model, openaiCodexOptions());
		});
	});
});
