import { describe, expect, it } from "vite-plus/test";
import type { AnthropicOptions, OpenAICodexOptions, OpenAIOptions } from "../../src/llm/options";
import { Message } from "../../src/message/message";
import { Model } from "../../src/model/model";
import { stream } from "../../src/stream";
import {
	anthropicOptions,
	describeIfAnthropic,
	describeIfOpenAI,
	describeIfOpenAICodex,
	getAnthropicModel,
	getOpenAICodexModel,
	getOpenAIModel,
	getText,
	openaiCodexOptions,
	openaiOptions,
} from "../utils/llm";

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

function expectXhighSupport(model: Model.Info, clamped: Model.ThinkingLevel) {
	expect(Model.getSupportedThinkingLevels(model)).not.toContain("xhigh");
	expect(Model.clampThinkingLevel(model, "xhigh")).toBe(clamped);
}

async function completeWithXhigh(model: Model.Info, options: AnthropicOptions | OpenAIOptions | OpenAICodexOptions) {
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
		const options = openaiOptions();

		it("should ignore xhigh for a non-reasoning model", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIModel();
			expectXhighSupport(model, "off");
			await completeWithXhigh(model, options);
		});
	});

	describeIfOpenAI("openai reasoning provider (o3-mini)", () => {
		const options = openaiOptions();

		it("should clamp unsupported xhigh to high", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIModel("o3-mini");
			expectXhighSupport(model, "high");
			await completeWithXhigh(model, options);
		});
	});

	describeIfAnthropic("anthropic provider (claude-sonnet-4-20250514)", () => {
		const options = anthropicOptions();

		it("should clamp unsupported xhigh to high", { retry: 3, timeout: 30000 }, async () => {
			const model = await getAnthropicModel("claude-sonnet-4-20250514");
			expectXhighSupport(model, "high");
			await completeWithXhigh(model, options);
		});
	});

	describeIfOpenAICodex("openai codex provider (gpt-5.4)", () => {
		const options = openaiCodexOptions();

		it("should support xhigh natively", { retry: 3, timeout: 120000 }, async () => {
			const model = await getOpenAICodexModel();
			expect(Model.getSupportedThinkingLevels(model)).toContain("xhigh");
			expect(Model.clampThinkingLevel(model, "xhigh")).toBe("xhigh");
			await completeWithXhigh(model, options);
		});
	});
});
