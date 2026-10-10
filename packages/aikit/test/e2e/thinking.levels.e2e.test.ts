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
// both, Opus and Sonnet 5.5 reject disabled thinking, and Haiku 4.5 only takes a budget.
const ANTHROPIC_LEVELS: Record<(typeof ANTHROPIC_E2E_MODELS)[number], Model.ThinkingLevel[]> = {
	"claude-sonnet-4-6": [...ANTHROPIC_BUDGET, "max"],
	"claude-sonnet-5": ANTHROPIC_XHIGH_MAX,
	"claude-sonnet-5-5": ANTHROPIC_XHIGH_MAX.slice(2),
	"claude-opus-4-6": ANTHROPIC_XHIGH_MAX,
	"claude-opus-4-8": ANTHROPIC_XHIGH_MAX,
	"claude-opus-5-5": ANTHROPIC_XHIGH_MAX.slice(2),
	"claude-haiku-5-5": ANTHROPIC_XHIGH_MAX,
	"claude-haiku-4-5-20251001": ANTHROPIC_BUDGET,
};

type Provider = "openai" | "openai-codex" | "anthropic" | "openrouter";
interface Recorded {
	readonly thinkingLevel: Model.ThinkingLevel;
	readonly providerThinkingLevel: string | null;
	/** Only recorded where the test asserts it: adaptive models think unpredictably at low efforts. */
	readonly thinking?: boolean;
}
const recorded = new Map<Provider, Map<string, Map<Model.ThinkingLevel, Recorded>>>();

function record(provider: Provider, model: StreamableModel, response: Message.AssistantMessage, thinking?: boolean) {
	const models = recorded.get(provider) ?? new Map<string, Map<Model.ThinkingLevel, Recorded>>();
	const levels = models.get(model.id) ?? new Map<Model.ThinkingLevel, Recorded>();
	levels.set(response.thinkingLevel, {
		thinkingLevel: response.thinkingLevel,
		providerThinkingLevel: response.providerThinkingLevel ?? null,
		...(thinking === undefined ? {} : { thinking }),
	});
	models.set(model.id, levels);
	recorded.set(provider, models);
}

/** Models and levels in catalog order, so the artifact only changes when a level does. */
function artifact(provider: Provider, models: ReadonlyArray<string>): string {
	const levels: Model.ThinkingLevel[] = ["off", ...ACTIVE_LEVELS];
	const entries = models.flatMap((modelId) => {
		const byLevel = recorded.get(provider)?.get(modelId);
		if (byLevel === undefined) return [];
		return [
			[
				modelId,
				Object.fromEntries(levels.flatMap((level) => (byLevel.has(level) ? [[level, byLevel.get(level)]] : []))),
			],
		];
	});
	return JSON.stringify(Object.fromEntries(entries), null, "\t");
}

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
	expect(response.thinkingLevel).toBe((options as { reasoning?: Model.ThinkingLevel }).reasoning ?? "off");
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
		const thinking = response.parts.some((part) => part.type === "thinking");
		record("openai", model, response, thinking);
		expect(thinking).toBe(false);
		expect(response.providerThinkingLevel).toBeDefined();
	});

	it.each(ACTIVE_LEVELS)("accepts reasoning %s", { retry: 2, timeout: 180_000 }, async (reasoning) => {
		const model = await getOpenAIModel(modelId);
		const response = await expectLevelAccepted(model, openaiOptions({ reasoning }));
		record("openai", model, response);
		expect(response.providerThinkingLevel).toBeDefined();
	});
});

describeIfOpenAI("OpenAI thinking levels artifact", () => {
	it("records the level each model ran at", async () => {
		await expect(artifact("openai", OPENAI_E2E_MODELS)).toMatchFileSnapshot(
			"./__artifacts__/thinking.levels.openai.json",
		);
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
		const thinking = response.parts.some((part) => part.type === "thinking");
		record("openai-codex", model, response, thinking);
		expect(thinking).toBe(false);
		expect(response.providerThinkingLevel).toBeDefined();
	});

	it.each(ACTIVE_LEVELS)("accepts reasoning %s", { retry: 2, timeout: 180_000 }, async (reasoning) => {
		const model = await getOpenAICodexModel(modelId);
		const response = await expectLevelAccepted(model, openaiCodexOptions({ reasoning }));
		record("openai-codex", model, response);
		expect(response.providerThinkingLevel).toBeDefined();
	});
});

describeIfOpenAICodex("OpenAI Codex thinking levels artifact", () => {
	it("records the level each model ran at", async () => {
		await expect(artifact("openai-codex", OPENAI_CODEX_E2E_MODELS)).toMatchFileSnapshot(
			"./__artifacts__/thinking.levels.openai-codex.json",
		);
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
		const canDisable = ANTHROPIC_LEVELS[modelId].includes("off");
		// A model that cannot disable thinking runs at Anthropic's default effort, and may think.
		if (canDisable) {
			const thinking = response.parts.some((part) => part.type === "thinking");
			record("anthropic", model, response, thinking);
			expect(thinking).toBe(false);
			expect(response.providerThinkingLevel).toBeUndefined();
		} else {
			record("anthropic", model, response);
			expect(response.providerThinkingLevel).toBe("high");
		}
	});

	it.each(ACTIVE_LEVELS)("accepts reasoning %s", { retry: 2, timeout: 180_000 }, async (reasoning) => {
		const model = await getAnthropicModel(modelId);
		const response = await expectLevelAccepted(model, anthropicOptions({ reasoning }));
		record("anthropic", model, response);
		if (model.compat?.forceAdaptiveThinking) expect(response.providerThinkingLevel).toBeDefined();
		else expect(response.providerThinkingLevel).toBeUndefined();
	});
});

describeIfAnthropic("Anthropic thinking levels artifact", () => {
	it("records the level each model ran at", async () => {
		await expect(artifact("anthropic", ANTHROPIC_E2E_MODELS)).toMatchFileSnapshot(
			"./__artifacts__/thinking.levels.anthropic.json",
		);
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
		const model = await getOpenRouterModel(modelId);
		const response = await expectLevelAccepted(model, openrouterOptions());
		record("openrouter", model, response);
		expect(response.providerThinkingLevel).toBeUndefined();
	});

	it.each(ACTIVE_LEVELS)("accepts reasoning %s", { retry: 2, timeout: 180_000 }, async (reasoning) => {
		const model = await getOpenRouterModel(modelId);
		const response = await expectLevelAccepted(model, openrouterOptions({ reasoning }));
		record("openrouter", model, response);
		expect(response.providerThinkingLevel).toBeDefined();
	});
});

describeIfOpenRouter("OpenRouter thinking levels artifact", () => {
	it("records the level each model ran at", async () => {
		await expect(artifact("openrouter", OPENROUTER_E2E_MODELS)).toMatchFileSnapshot(
			"./__artifacts__/thinking.levels.openrouter.json",
		);
	});
});
