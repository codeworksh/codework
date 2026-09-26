import { describe, expect, it } from "vite-plus/test";
import { Pricing } from "../src/llm/pricing.ts";
import { makeGeneratedModel, makeModel } from "./utils/fixtures.ts";

const openai = makeGeneratedModel("gpt-5.6", "@ai-sdk/openai");
const codex = makeModel({ id: "gpt-5.4", protocol: "openai-codex", providerOptionsKey: "openai-codex" });
const anthropic = makeModel({ id: "claude-sonnet-5", protocol: "anthropic", providerOptionsKey: "anthropic" });

describe("Pricing.requestedServiceTier", () => {
	it("falls back to factory options, then to the model's own options", () => {
		expect(Pricing.requestedServiceTier(codex, { factoryOptions: { serviceTier: "priority" } }, {})).toBe("priority");
		const withTier = makeModel({ ...codex, options: { serviceTier: "flex" } });
		expect(Pricing.requestedServiceTier(withTier, {}, {})).toBe("flex");
	});

	it("ignores protocols that do not price by service tier", () => {
		expect(Pricing.requestedServiceTier(anthropic, {}, { anthropic: { serviceTier: "flex" } })).toBeUndefined();
	});
});

describe("Pricing.servedServiceTier", () => {
	it("keeps an explicit codex flex or priority request over a default response", () => {
		expect(Pricing.servedServiceTier(codex, "priority", { "openai-codex": { serviceTier: "default" } })).toBe(
			"priority",
		);
	});

	it("takes a default openai response at face value", () => {
		expect(Pricing.servedServiceTier(openai, "priority", { openai: { serviceTier: "default" } })).toBe("default");
	});
});

describe("Pricing.serviceTierCostMultiplier", () => {
	it("uses custom pricing metadata without recognizing the model name", () => {
		const model = makeModel({ cost: { ...openai.cost, serviceTierMultipliers: { priority: 3 } } });
		expect(Pricing.serviceTierCostMultiplier(model, "priority")).toBe(3);
		expect(Pricing.serviceTierCostMultiplier(makeModel({ id: "gpt-5.5" }), "priority")).toBe(1);
	});
});

describe("Pricing.cacheWrite1hTokens", () => {
	it("reads the same split from Vertex Anthropic", () => {
		expect(
			Pricing.cacheWrite1hTokens({
				"google-vertex-anthropic": { usage: { cache_creation: { ephemeral_1h_input_tokens: 25 } } },
			}),
		).toBe(25);
	});
});
