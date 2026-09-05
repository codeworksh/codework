import { describe, expect, it } from "vite-plus/test";
import { Pricing } from "../src/llm/pricing.ts";
import { makeGeneratedModel, makeModel } from "./utils/fixtures.ts";

const openai = makeGeneratedModel("gpt-5.6", "@ai-sdk/openai");
const codex = makeModel({ id: "gpt-5.4", protocol: "openai-codex", providerOptionsKey: "openai-codex" });
const anthropic = makeModel({ id: "claude-sonnet-5", protocol: "anthropic", providerOptionsKey: "anthropic" });

describe("Pricing.requestedServiceTier", () => {
	it("reads the tier from provider options", () => {
		expect(Pricing.requestedServiceTier(openai, {}, { openai: { serviceTier: "flex" } })).toBe("flex");
	});

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
	it("prefers the tier the response was served at", () => {
		expect(Pricing.servedServiceTier(openai, "auto", { openai: { serviceTier: "priority" } })).toBe("priority");
	});

	it("falls back to the requested tier when the response reports none", () => {
		expect(Pricing.servedServiceTier(openai, "flex", undefined)).toBe("flex");
	});

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
	it("halves the cost on flex", () => {
		expect(Pricing.serviceTierCostMultiplier(openai, "flex")).toBe(0.5);
	});

	it("doubles the cost on priority, and 2.5x for gpt-5.5", () => {
		expect(Pricing.serviceTierCostMultiplier(openai, "priority")).toBe(2);
		expect(Pricing.serviceTierCostMultiplier(makeGeneratedModel("gpt-5.5", "@ai-sdk/openai"), "priority")).toBe(2.5);
	});

	it("leaves the cost alone for auto, default, and unset", () => {
		expect(Pricing.serviceTierCostMultiplier(openai, "auto")).toBe(1);
		expect(Pricing.serviceTierCostMultiplier(openai, "default")).toBe(1);
		expect(Pricing.serviceTierCostMultiplier(openai, undefined)).toBe(1);
	});
});

describe("Pricing.cacheWrite1hTokens", () => {
	it("reads Anthropic's 1h cache creation split", () => {
		expect(
			Pricing.cacheWrite1hTokens({
				anthropic: { usage: { cache_creation: { ephemeral_1h_input_tokens: 400_000 } } },
			}),
		).toBe(400_000);
	});

	it("reads the same split from Vertex Anthropic", () => {
		expect(
			Pricing.cacheWrite1hTokens({
				"google-vertex-anthropic": { usage: { cache_creation: { ephemeral_1h_input_tokens: 25 } } },
			}),
		).toBe(25);
	});

	it("returns undefined when the provider reports no breakdown", () => {
		expect(Pricing.cacheWrite1hTokens(undefined)).toBeUndefined();
		expect(Pricing.cacheWrite1hTokens({ anthropic: { usage: { input_tokens: 10 } } })).toBeUndefined();
		expect(Pricing.cacheWrite1hTokens({ openai: { serviceTier: "flex" } })).toBeUndefined();
	});
});
