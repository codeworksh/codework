import { describe, expect, it } from "vite-plus/test";
import { mapUsage } from "../src/llm/transform.ts";
import * as Model from "../src/model/model.ts";
import { makeLanguageModelUsage, makeModel, makeUsage } from "./utils/fixtures.ts";

// claude-opus-4-8 rates: input 5, cacheWrite (5m) 6.25 per Mtok. A 1h write costs 2x input = 10.
const opus = makeModel({
	id: "claude-opus-4-8",
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
});

describe("Model.calculateCost with 1h cache writes", () => {
	it("prices the 1h portion at 2x input and the rest at the 5m rate", () => {
		const usage = makeUsage({ cacheWrite: 1_000_000, cacheWrite1h: 400_000 });

		Model.calculateCost(opus, usage);

		// 600k * 6.25/Mtok + 400k * 10/Mtok = 3.75 + 4.0 = 7.75
		expect(usage.cost.cacheWrite).toBeCloseTo(7.75, 10);
	});

	it("falls back to the 5m rate when no breakdown is reported", () => {
		const usage = makeUsage({ cacheWrite: 1_000_000 });

		Model.calculateCost(opus, usage);

		expect(usage.cost.cacheWrite).toBeCloseTo(6.25, 10);
	});

	it("prices an all-1h write entirely at 2x input", () => {
		const usage = makeUsage({ cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 });

		Model.calculateCost(opus, usage);

		expect(usage.cost.cacheWrite).toBeCloseTo(10, 10);
	});

	it("includes the 1h premium in the total", () => {
		const usage = makeUsage({ input: 1_000_000, cacheWrite: 1_000_000, cacheWrite1h: 400_000 });

		Model.calculateCost(opus, usage);

		expect(usage.cost.total).toBeCloseTo(5 + 7.75, 10);
	});
});

describe("mapUsage 1h cache write breakdown", () => {
	const usage = makeLanguageModelUsage({
		inputTokens: 1_000_100,
		outputTokens: 5,
		totalTokens: 1_000_105,
		inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 1_000_000 },
	});

	it("reads the split out of Anthropic's raw usage metadata", () => {
		const result = mapUsage(usage, opus, 1, {
			anthropic: {
				usage: {
					cache_creation: { ephemeral_5m_input_tokens: 600_000, ephemeral_1h_input_tokens: 400_000 },
				},
			},
		});

		expect(result.cacheWrite).toBe(1_000_000);
		expect(result.cacheWrite1h).toBe(400_000);
		expect(result.cost.cacheWrite).toBeCloseTo(7.75, 10);
	});

	it("omits the split when the provider does not report one", () => {
		const result = mapUsage(usage, opus, 1, { anthropic: { usage: { input_tokens: 100 } } });

		expect(result.cacheWrite1h).toBeUndefined();
		expect(result.cost.cacheWrite).toBeCloseTo(6.25, 10);
	});

	it("ignores metadata from unrelated providers", () => {
		const result = mapUsage(usage, opus, 1, { openai: { serviceTier: "flex" } });

		expect(result.cacheWrite1h).toBeUndefined();
		expect(result.cost.cacheWrite).toBeCloseTo(6.25, 10);
	});
});
