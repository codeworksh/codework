import { expect, it } from "vite-plus/test";
import * as Message from "../../src/message/message.ts";
import * as Model from "../../src/model/model.ts";
import { stream } from "../../src/stream.ts";
import {
	ANTHROPIC_E2E_MODELS,
	anthropicOptions,
	describeIfAnthropic,
	describeIfOpenAI,
	describeIfOpenAICodex,
	getAnthropicModel,
	getOpenAICodexModel,
	getOpenAIModel,
	getText,
	OPENAI_CODEX_E2E_MODELS,
	OPENAI_E2E_MODELS,
	openaiCodexOptions,
	openaiOptions,
	type StreamableModel,
	OPENROUTER_E2E_MODELS,
	describeIfOpenRouter,
	getOpenRouterModel,
	openrouterOptions,
} from "../utils/llm.ts";

/*
 * Every level a caller can request must reach the API as an effort it accepts:
 * supported levels pass through, unsupported ones (e.g. OpenAI minimal, Claude
 * 4.6 xhigh) are clamped by the catalog's thinkingLevelMap.
 */
const ACTIVE_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

const WITH_MAX: Model.ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh", "max"];
const WITH_XHIGH: Model.ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"];

// Checked live: the Responses API rejects minimal on all of these and max below gpt-5.6.
const OPENAI_LEVELS: Record<(typeof OPENAI_E2E_MODELS)[number], Model.ThinkingLevel[]> = {
	"gpt-6-luna": WITH_MAX,
	"gpt-5.6-luna": WITH_MAX,
	"gpt-5.5": WITH_XHIGH,
	"gpt-5.4": WITH_XHIGH,
	"gpt-5.4-mini": WITH_XHIGH,
	"gpt-5.4-nano": WITH_XHIGH,
};

// Checked live: Codex accepts the same efforts, "none" included.
const OPENAI_CODEX_LEVELS: Record<(typeof OPENAI_CODEX_E2E_MODELS)[number], Model.ThinkingLevel[]> = {
	"gpt-6-luna": WITH_MAX,
	"gpt-5.6-luna": WITH_MAX,
	"gpt-5.5": WITH_XHIGH,
};

const ANTHROPIC_BUDGET: Model.ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
const ANTHROPIC_XHIGH_MAX: Model.ThinkingLevel[] = [...ANTHROPIC_BUDGET, "xhigh", "max"];

// Checked live: 4.6 takes max but not xhigh (Opus maps xhigh onto max), 4.8 and 5.x take
// both, the 5.5 and Fable models reject disabled thinking, and the 4.5 models only take a budget.
const ANTHROPIC_LEVELS: Record<(typeof ANTHROPIC_E2E_MODELS)[number], Model.ThinkingLevel[]> = {
	"claude-sonnet-4-6": [...ANTHROPIC_BUDGET, "max"],
	"claude-sonnet-5": ANTHROPIC_XHIGH_MAX,
	"claude-sonnet-5-5": ANTHROPIC_XHIGH_MAX.slice(2),
	"claude-opus-4-6": ANTHROPIC_XHIGH_MAX,
	"claude-opus-4-8": ANTHROPIC_XHIGH_MAX,
	"claude-opus-5-5": ANTHROPIC_XHIGH_MAX.slice(2),
	"claude-fable-5-1": ANTHROPIC_XHIGH_MAX.slice(1),
	"claude-sonnet-4-5-20250929": ANTHROPIC_BUDGET,
	"claude-haiku-4-5-20251001": ANTHROPIC_BUDGET,
};

async function expectLevelAccepted(model: StreamableModel, options: object) {
	const a = (Math.random() * 100) | 0;
	const b = (Math.random() * 100) | 0;
	const response = await stream.complete(
		model,
		{
			systemPrompt: "You are a helpful assistant. Be concise.",
			messages: [
				Message.createUserMessage({
					role: "user",
					time: { created: Date.now() },
					parts: [{ type: "text", text: `What is ${a} + ${b}? Reply with the number only.` }],
				}),
			],
		},
		options,
	);

	expect(response.stopReason, response.errorMessage).toBe("stop");
	expect(getText(response)).toContain(String(a + b));
	return response;
}

describeIfOpenAI.each(OPENAI_E2E_MODELS)("OpenAI thinking levels (%s)", (modelId) => {
	it("exposes the levels the API accepts", async () => {
		const model = await getOpenAIModel(modelId);
		expect(Model.getSupportedThinkingLevels(model)).toEqual(OPENAI_LEVELS[modelId]);
		expect(Model.clampThinkingLevel(model, "minimal")).toBe("low");
	});

	it("disables reasoning when no level is requested", { retry: 2, timeout: 60_000 }, async () => {
		const model = await getOpenAIModel(modelId);
		const { reasoning: _, ...off } = openaiOptions();
		const response = await expectLevelAccepted(model, off);
		expect(response.parts.some((part) => part.type === "thinking")).toBe(false);
	});

	it.each(ACTIVE_LEVELS)("accepts reasoning %s", { retry: 2, timeout: 180_000 }, async (reasoning) => {
		const model = await getOpenAIModel(modelId);
		await expectLevelAccepted(model, openaiOptions({ reasoning }));
	});
});

describeIfOpenAICodex.each(OPENAI_CODEX_E2E_MODELS)("OpenAI Codex thinking levels (%s)", (modelId) => {
	it("exposes the levels the API accepts", async () => {
		const model = await getOpenAICodexModel(modelId);
		expect(Model.getSupportedThinkingLevels(model)).toEqual(OPENAI_CODEX_LEVELS[modelId]);
		expect(Model.clampThinkingLevel(model, "minimal")).toBe("low");
	});

	it("disables reasoning when no level is requested", { retry: 2, timeout: 60_000 }, async () => {
		const model = await getOpenAICodexModel(modelId);
		const { reasoning: _, ...off } = openaiCodexOptions();
		const response = await expectLevelAccepted(model, off);
		expect(response.parts.some((part) => part.type === "thinking")).toBe(false);
	});

	it.each(ACTIVE_LEVELS)("accepts reasoning %s", { retry: 2, timeout: 180_000 }, async (reasoning) => {
		const model = await getOpenAICodexModel(modelId);
		await expectLevelAccepted(model, openaiCodexOptions({ reasoning }));
	});
});

describeIfAnthropic.each(ANTHROPIC_E2E_MODELS)("Anthropic thinking levels (%s)", (modelId) => {
	it("exposes the levels the API accepts", async () => {
		const model = await getAnthropicModel(modelId);
		expect(Model.getSupportedThinkingLevels(model)).toEqual(ANTHROPIC_LEVELS[modelId]);
	});

	it("answers when no level is requested", { retry: 2, timeout: 60_000 }, async () => {
		const model = await getAnthropicModel(modelId);
		const response = await expectLevelAccepted(model, anthropicOptions());
		// Models that cannot disable thinking may still think; the request must not fail.
		if (ANTHROPIC_LEVELS[modelId].includes("off")) {
			expect(response.parts.some((part) => part.type === "thinking")).toBe(false);
		}
	});

	it.each(ACTIVE_LEVELS)("accepts reasoning %s", { retry: 2, timeout: 180_000 }, async (reasoning) => {
		const model = await getAnthropicModel(modelId);
		await expectLevelAccepted(model, anthropicOptions({ reasoning }));
	});
});

// OpenRouter leaves reasoning to each endpoint: several make it mandatory, so off is
// never sent, and xhigh and max clamp to high.
describeIfOpenRouter.each(OPENROUTER_E2E_MODELS)("OpenRouter thinking levels (%s)", (modelId) => {
	it("exposes the default levels", async () => {
		const model = await getOpenRouterModel(modelId);
		expect(Model.getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high"]);
	});

	it("answers when no level is requested", { retry: 2, timeout: 60_000 }, async () => {
		await expectLevelAccepted(await getOpenRouterModel(modelId), openrouterOptions());
	});

	it.each(ACTIVE_LEVELS)("accepts reasoning %s", { retry: 2, timeout: 180_000 }, async (reasoning) => {
		const model = await getOpenRouterModel(modelId);
		await expectLevelAccepted(model, openrouterOptions({ reasoning }));
	});
});
