import { describe, expect, it } from "vite-plus/test";
import type { AnthropicOptions } from "../../src/llm/options.ts";
import * as Message from "../../src/message/message.ts";
import * as Model from "../../src/model/model.ts";
import { stream } from "../../src/stream.ts";
import {
	anthropicOptions,
	describeIfAnthropic,
	describeIfOpenAI,
	describeIfOpenAICodex,
	getAnthropicModel,
	getOpenAICodexModel,
	getOpenAIModel,
	getText,
	OPENAI_CODEX_E2E_MODEL,
	OPENAI_E2E_MODEL,
} from "../utils/llm.ts";

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

async function completeWithXhigh(model: Model.Info, options: AnthropicOptions) {
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
	describeIfOpenAI(`openai provider (${OPENAI_E2E_MODEL})`, () => {
		it("should clamp unsupported xhigh to high", async () => {
			const model = await getOpenAIModel();
			expectXhighSupport(model, "high");
		});
	});

	describeIfAnthropic("anthropic provider (claude-haiku-4-5)", () => {
		const options = anthropicOptions();

		it("should clamp unsupported xhigh to high", { retry: 3, timeout: 30000 }, async () => {
			const model = await getAnthropicModel();
			expectXhighSupport(model, "high");
			await completeWithXhigh(model, options);
		});
	});

	describeIfOpenAICodex(`openai codex provider (${OPENAI_CODEX_E2E_MODEL})`, () => {
		it("should support xhigh in the catalog without a live xhigh call", async () => {
			const model = await getOpenAICodexModel();
			expect(Model.getSupportedThinkingLevels(model)).toContain("xhigh");
			expect(Model.clampThinkingLevel(model, "xhigh")).toBe("xhigh");
		});
	});
});
