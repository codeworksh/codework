import { describe, expect, it } from "vite-plus/test";
import { resolveMaxOutputTokens } from "../src/llm/stream.ts";
import { Thinking } from "../src/llm/thinking.ts";
import * as Message from "../src/message/message.ts";
import { makeGeneratedModel, makeModel, makeUsage } from "./utils/fixtures.ts";

const emptyContext: Message.Context = { messages: [] };

function planFor(model: ReturnType<typeof makeModel>, options: Parameters<typeof Thinking.resolvePlan>[2] = {}) {
	return Thinking.resolvePlan(model, emptyContext, options);
}

function google(id: string) {
	return makeGeneratedModel(id);
}

describe("Thinking.resolvePlan", () => {
	it("uses catalog budgets for an unknown ID and lets caller budgets override them", () => {
		const model = makeModel({
			id: "custom",
			protocol: "google",
			reasoning: true,
			maxTokens: 64_000,
			thinkingBudgets: { high: 6_000 },
		});
		expect(planFor(model, { reasoning: "high", maxTokens: 2_000 })).toMatchObject({
			budget: 6_000,
			maxTokens: 8_000,
			explicit: false,
		});
		expect(planFor(model, { reasoning: "high", maxTokens: 2_000, thinkingBudgets: { high: 3_000 } })).toMatchObject({
			budget: 3_000,
			maxTokens: 5_000,
			explicit: true,
		});
	});
});

describe("Thinking.reasoningProviderOptions", () => {
	it("uses a level for an arbitrary model ID when the catalog declares support", () => {
		const model = makeModel({
			id: "custom",
			protocol: "google",
			reasoning: true,
			compat: { supportsThinkingLevel: true },
		});
		expect(
			Thinking.reasoningProviderOptions(model, planFor(model, { reasoning: "low" })).google?.thinkingConfig,
		).toEqual({ thinkingLevel: "low", includeThoughts: true });
	});
	it("uses model metadata for the minimum supported Google level", () => {
		const model = { ...google("gemini-3-flash-custom"), thinkingLevelMap: { off: "low", minimal: null } };
		expect(Thinking.reasoningProviderOptions(model, planFor(model)).google?.thinkingConfig).toEqual({
			thinkingLevel: "low",
		});
		expect(
			Thinking.reasoningProviderOptions(model, planFor(model, { reasoning: "minimal" })).google?.thinkingConfig,
		).toEqual({ thinkingLevel: "low", includeThoughts: true });
	});
});

describe("Thinking.disabledProviderOptions", () => {
	const off = (overrides: Parameters<typeof makeModel>[0]) =>
		Thinking.reasoningProviderOptions(makeModel(overrides), planFor(makeModel(overrides)));

	it("leaves OpenRouter alone, where disabling is rejected per endpoint", () => {
		expect(
			off({ id: "z-ai/glm-5.3-flash", protocol: "openrouter", providerOptionsKey: "openrouter", reasoning: true }),
		).toEqual({});
	});

	it("uses the model's own off mapping when it has one", () => {
		expect(
			off({
				protocol: "openai",
				providerOptionsKey: "openai",
				reasoning: true,
				thinkingLevelMap: { off: "minimal" },
			}),
		).toEqual({ openai: { reasoningEffort: "minimal" } });
	});

	it("stays quiet for a model that cannot turn reasoning off", () => {
		expect(
			off({ protocol: "openai", providerOptionsKey: "openai", reasoning: true, thinkingLevelMap: { off: null } }),
		).toEqual({});
	});

	it("falls back to the lowest level for Gemini 3, which cannot disable thinking", () => {
		expect(
			off({
				id: "gemini-3.1-pro-preview",
				protocol: "google",
				providerOptionsKey: "google",
				reasoning: true,
				compat: { supportsThinkingLevel: true },
				thinkingLevelMap: { off: "low", minimal: null },
			}),
		).toEqual({
			google: { thinkingConfig: { thinkingLevel: "low" } },
		});
		expect(off({ ...google("gemini-3.1-flash") })).toEqual({
			google: { thinkingConfig: { thinkingLevel: "minimal" } },
		});
		expect(off({ ...google("gemma-4-31b-it") })).toEqual({
			google: { thinkingConfig: { thinkingLevel: "minimal" } },
		});
	});
});

describe("resolveMaxOutputTokens", () => {
	const anthropic = (maxTokens: number) =>
		makeModel({ protocol: "anthropic", providerOptionsKey: "anthropic", reasoning: true, maxTokens });

	it("gives Anthropic the answer room, since the SDK adds the budget back on", () => {
		const model = anthropic(64_000);
		const plan = planFor(model, { reasoning: "high" });
		// plan.maxTokens is the whole response; @ai-sdk/anthropic sends
		// max_tokens = maxOutputTokens + budget, so it must receive the difference.
		expect(plan.maxTokens).toBe(64_000);
		expect(plan.budget).toBe(16_384);
		expect(resolveMaxOutputTokens(model, plan)).toBe(64_000 - 16_384);
	});

	it("never sends a ceiling to the Codex backend, which rejects it", () => {
		const model = makeModel({ protocol: "openai-codex", providerOptionsKey: "openai-codex", reasoning: true });
		expect(resolveMaxOutputTokens(model, planFor(model, { reasoning: "high" }))).toBeUndefined();
	});
});

describe("Anthropic adaptive thinking", () => {
	const adaptive = (id = "claude-sonnet-5", thinkingLevelMap?: Record<string, string | null>) =>
		makeModel({
			id,
			protocol: "anthropic",
			providerOptionsKey: "anthropic",
			reasoning: true,
			maxTokens: 64_000,
			compat: { forceAdaptiveThinking: true },
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		});

	it("sends an effort level and no budget", () => {
		const model = adaptive();
		const options = Thinking.reasoningProviderOptions(model, planFor(model, { reasoning: "medium" }));
		expect(options.anthropic).toEqual({
			thinking: { type: "adaptive", display: "summarized" },
			effort: "medium",
		});
	});

	it("maps minimal and low onto the lowest effort", () => {
		const model = adaptive();
		for (const level of ["minimal", "low"] as const) {
			const options = Thinking.reasoningProviderOptions(model, planFor(model, { reasoning: level }));
			expect(options.anthropic?.effort).toBe("low");
		}
	});

	it("lets the model's own level map decide xhigh and max", () => {
		const model = adaptive("claude-opus-4-6", { xhigh: "max" });
		const options = Thinking.reasoningProviderOptions(model, planFor(model, { reasoning: "xhigh" }));
		expect(options.anthropic?.effort).toBe("max");
	});

	it("sends the whole ceiling for adaptive models, since no budget is added back", () => {
		const model = adaptive();
		const plan = planFor(model, { reasoning: "high", maxTokens: 4_096 });
		expect(plan.maxTokens).toBe(4_096 + 16_384);
		expect(resolveMaxOutputTokens(model, plan)).toBe(4_096 + 16_384);
	});
});

describe("provider thinking-budget floor", () => {
	const anthropic = makeModel({
		protocol: "anthropic",
		providerOptionsKey: "anthropic",
		reasoning: true,
		maxTokens: 64_000,
		contextWindow: 200_000,
	});

	/** A conversation that has nearly filled the model's window. */
	const nearlyFull: Message.Context = {
		messages: [
			Message.createAssistantMessage({
				role: "assistant",
				parts: [{ type: "text", text: "prior" }],
				protocol: anthropic.protocol,
				provider: anthropic.provider,
				model: anthropic.id,
				usage: makeUsage({ input: 198_000, totalTokens: 198_000 }),
				stopReason: "stop",
				time: { created: 1, completed: 2 },
			}),
		],
	};

	it("drops thinking rather than sending a budget below Anthropic's floor", () => {
		// The context clamp leaves no room, so a fitted budget would fall under 1024
		// and Anthropic would reject the request outright.
		const plan = Thinking.resolvePlan(anthropic, nearlyFull, { reasoning: "high" });
		expect(plan.level).toBe("off");
		expect(plan.budget).toBe(0);
		expect(Thinking.reasoningProviderOptions(anthropic, plan)).toEqual({
			anthropic: { thinking: { type: "disabled" } },
		});
	});

	it("does not apply a floor to adaptive models, which send no budget", () => {
		const adaptive = makeModel({
			id: "claude-sonnet-5",
			protocol: "anthropic",
			providerOptionsKey: "anthropic",
			reasoning: true,
			maxTokens: 64_000,
			contextWindow: 200_000,
			compat: { forceAdaptiveThinking: true },
		});
		const plan = Thinking.resolvePlan(adaptive, nearlyFull, { reasoning: "high" });
		expect(plan.level).toBe("high");
		expect(Thinking.reasoningProviderOptions(adaptive, plan).anthropic).toMatchObject({
			thinking: { type: "adaptive", display: "summarized" },
		});
	});
});
