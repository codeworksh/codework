import { describe, expect, it } from "vite-plus/test";
import { resolveMaxOutputTokens } from "../src/llm/stream.ts";
import { Thinking } from "../src/llm/thinking.ts";
import * as Message from "../src/message/message.ts";
import { makeModel, makeUsage } from "./utils/fixtures.ts";

const emptyContext: Message.Context = { messages: [] };

function planFor(model: ReturnType<typeof makeModel>, options: Parameters<typeof Thinking.resolvePlan>[2] = {}) {
	return Thinking.resolvePlan(model, emptyContext, options);
}

function google(id: string) {
	return makeModel({ id, protocol: "google", providerOptionsKey: "google", reasoning: true, maxTokens: 64_000 });
}

describe("Thinking.resolvePlan", () => {
	const model = makeModel({ reasoning: true, maxTokens: 64_000, contextWindow: 200_000 });

	it("stays off when no reasoning level is requested", () => {
		expect(planFor(model)).toMatchObject({ level: "off", budget: 0 });
	});

	it("clamps the level to what the model supports", () => {
		// makeModel declares no thinkingLevelMap, so xhigh is unsupported and walks down.
		expect(planFor(model, { reasoning: "xhigh" }).level).toBe("high");
	});

	it("fits the default budget under the model ceiling", () => {
		expect(planFor(model, { reasoning: "medium" })).toMatchObject({ maxTokens: 64_000, budget: 8_192 });
	});

	it("adds an explicit answer cap on top of the budget", () => {
		expect(planFor(model, { reasoning: "high", maxTokens: 4_096 })).toMatchObject({
			maxTokens: 4_096 + 16_384,
			budget: 16_384,
		});
	});

	it("shrinks the budget, not the answer, on a small model", () => {
		const small = makeModel({ reasoning: true, maxTokens: 8_192, contextWindow: 200_000 });
		expect(planFor(small, { reasoning: "high", thinkingBudgets: { high: 32_768 } })).toMatchObject({
			maxTokens: 8_192,
			budget: 8_192 - 1_024,
		});
	});

	it("marks a caller-configured budget as explicit", () => {
		expect(planFor(model, { reasoning: "medium" }).explicit).toBe(false);
		expect(planFor(model, { reasoning: "medium", thinkingBudgets: { medium: 100 } }).explicit).toBe(true);
	});
});

describe("Thinking.reasoningProviderOptions", () => {
	it("sends only an effort string for openai, xai, and codex", () => {
		const openai = makeModel({ protocol: "openai", providerOptionsKey: "openai", reasoning: true });
		const plan = planFor(openai, { reasoning: "medium" });
		expect(Thinking.reasoningProviderOptions(openai, plan)).toEqual({ openai: { reasoningEffort: "medium" } });
	});

	it("sends a fitted budget for anthropic", () => {
		const anthropic = makeModel({
			protocol: "anthropic",
			providerOptionsKey: "anthropic",
			reasoning: true,
			maxTokens: 64_000,
		});
		const plan = planFor(anthropic, { reasoning: "medium" });
		expect(Thinking.reasoningProviderOptions(anthropic, plan)).toEqual({
			anthropic: { thinking: { type: "enabled", budgetTokens: 8_192 } },
		});
	});

	it("keeps an explicit budget that leaves room for the answer", () => {
		const anthropic = makeModel({
			protocol: "anthropic",
			providerOptionsKey: "anthropic",
			reasoning: true,
			maxTokens: 64_000,
		});
		// 256 answer + 1024 thinking fits under the model ceiling, so neither is trimmed.
		const plan = planFor(anthropic, { reasoning: "high", maxTokens: 256, thinkingBudgets: { high: 1_024 } });
		expect(Thinking.reasoningProviderOptions(anthropic, plan)).toEqual({
			anthropic: { thinking: { type: "enabled", budgetTokens: 1_024 } },
		});
	});

	it("gives Gemini 3 and Gemma 4 a level and no budget", () => {
		for (const id of ["gemini-3-pro-preview", "gemini-3.1-flash", "gemma-4-27b", "gemini-flash-latest"]) {
			const model = google(id);
			const options = Thinking.reasoningProviderOptions(model, planFor(model, { reasoning: "medium" }));
			expect(options.google?.thinkingConfig).toEqual({ thinkingLevel: "medium", includeThoughts: true });
		}
	});

	it("gives each Gemini 2.5 family its own budget table", () => {
		const cases: Array<[string, number]> = [
			["gemini-2.5-pro", 32_768],
			["gemini-2.5-flash", 24_576],
			["gemini-2.5-flash-lite", 24_576],
		];
		for (const [id, expected] of cases) {
			const model = google(id);
			const options = Thinking.reasoningProviderOptions(model, planFor(model, { reasoning: "high" }));
			expect(options.google?.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: expected });
		}
	});

	it("asks Gemini to size thinking dynamically for unknown families", () => {
		const model = google("gemini-9-experimental");
		const options = Thinking.reasoningProviderOptions(model, planFor(model, { reasoning: "low" }));
		expect(options.google?.thinkingConfig).toMatchObject({ thinkingBudget: -1 });
	});

	it("prefers a caller-configured budget over the family table", () => {
		const model = google("gemini-2.5-pro");
		const plan = planFor(model, { reasoning: "high", thinkingBudgets: { high: 4_096 } });
		expect(Thinking.reasoningProviderOptions(model, plan).google?.thinkingConfig).toMatchObject({
			thinkingBudget: 4_096,
		});
	});
});

describe("Thinking.disabledProviderOptions", () => {
	const off = (overrides: Parameters<typeof makeModel>[0]) =>
		Thinking.reasoningProviderOptions(makeModel(overrides), planFor(makeModel(overrides)));

	it("sends nothing for a model that cannot reason", () => {
		expect(off({ protocol: "anthropic", providerOptionsKey: "anthropic", reasoning: false })).toEqual({});
	});

	it("disables Anthropic thinking outright", () => {
		expect(off({ protocol: "anthropic", providerOptionsKey: "anthropic", reasoning: true })).toEqual({
			anthropic: { thinking: { type: "disabled" } },
		});
	});

	it("leaves OpenRouter alone, where disabling is rejected per endpoint", () => {
		expect(
			off({ id: "z-ai/glm-5.3-flash", protocol: "openrouter", providerOptionsKey: "openrouter", reasoning: true }),
		).toEqual({});
	});

	it("sends an explicit effort of none for openai and xai", () => {
		expect(off({ protocol: "openai", providerOptionsKey: "openai", reasoning: true })).toEqual({
			openai: { reasoningEffort: "none" },
		});
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

	it("zeroes the budget for Gemini 2.x", () => {
		expect(off({ id: "gemini-2.5-pro", protocol: "google", providerOptionsKey: "google", reasoning: true })).toEqual({
			google: { thinkingConfig: { thinkingBudget: 0 } },
		});
	});

	it("falls back to the lowest level for Gemini 3, which cannot disable thinking", () => {
		expect(
			off({ id: "gemini-3.1-pro-preview", protocol: "google", providerOptionsKey: "google", reasoning: true }),
		).toEqual({
			google: { thinkingConfig: { thinkingLevel: "low" } },
		});
		expect(
			off({ id: "gemini-3.1-flash", protocol: "google", providerOptionsKey: "google", reasoning: true }),
		).toEqual({
			google: { thinkingConfig: { thinkingLevel: "minimal" } },
		});
		expect(off({ id: "gemma-4-31b-it", protocol: "google", providerOptionsKey: "google", reasoning: true })).toEqual({
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

	it("honours a caller's answer cap instead of inflating it by the budget", () => {
		const model = anthropic(64_000);
		const plan = planFor(model, { reasoning: "high", maxTokens: 4_096 });
		expect(plan.maxTokens).toBe(4_096 + 16_384);
		expect(resolveMaxOutputTokens(model, plan)).toBe(4_096);
	});

	it("passes the full ceiling through when thinking is off", () => {
		const model = anthropic(64_000);
		const plan = planFor(model, { maxTokens: 8_192 });
		expect(resolveMaxOutputTokens(model, plan)).toBe(8_192);
	});

	it("sends the whole ceiling to providers that do not add the budget", () => {
		const model = makeModel({ protocol: "openai", providerOptionsKey: "openai", reasoning: true, maxTokens: 64_000 });
		const plan = planFor(model, { reasoning: "high", maxTokens: 4_096 });
		expect(resolveMaxOutputTokens(model, plan)).toBe(4_096 + 16_384);
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

	const budgeted = makeModel({
		id: "claude-haiku-4-5",
		protocol: "anthropic",
		providerOptionsKey: "anthropic",
		reasoning: true,
		maxTokens: 64_000,
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

	it("still disables thinking outright when no reasoning is requested", () => {
		const model = adaptive();
		expect(Thinking.reasoningProviderOptions(model, planFor(model))).toEqual({
			anthropic: { thinking: { type: "disabled" } },
		});
	});

	it("keeps the budget path for older Claude models", () => {
		const options = Thinking.reasoningProviderOptions(budgeted, planFor(budgeted, { reasoning: "medium" }));
		expect(options.anthropic).toEqual({ thinking: { type: "enabled", budgetTokens: 8_192 } });
	});

	it("sends the whole ceiling for adaptive models, since no budget is added back", () => {
		const model = adaptive();
		const plan = planFor(model, { reasoning: "high", maxTokens: 4_096 });
		expect(plan.maxTokens).toBe(4_096 + 16_384);
		expect(resolveMaxOutputTokens(model, plan)).toBe(4_096 + 16_384);
	});

	it("still subtracts the budget for models that receive one", () => {
		const plan = planFor(budgeted, { reasoning: "high", maxTokens: 4_096 });
		expect(resolveMaxOutputTokens(budgeted, plan)).toBe(4_096);
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

	it("sends the whole remaining ceiling once thinking is dropped", () => {
		const plan = Thinking.resolvePlan(anthropic, nearlyFull, { reasoning: "high" });
		expect(resolveMaxOutputTokens(anthropic, plan)).toBe(plan.maxTokens);
	});

	it("keeps thinking when the window still has room", () => {
		const roomy: Message.Context = { messages: [] };
		expect(Thinking.resolvePlan(anthropic, roomy, { reasoning: "high" }).level).toBe("high");
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
