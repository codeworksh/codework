import { describe, expect, it } from "vite-plus/test";
import * as Model from "../src/model/model.ts";
import { makeModel, makeUsage } from "./utils/fixtures.ts";

describe("Model.calculateCost", () => {
	it("computes per-component cost from per-million-token pricing", () => {
		const model = makeModel({ cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } });
		const usage = makeUsage({ input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 100_000 });

		Model.calculateCost(model, usage);

		expect(usage.cost.input).toBeCloseTo(3);
		expect(usage.cost.output).toBeCloseTo(7.5);
		expect(usage.cost.cacheRead).toBeCloseTo(0.6);
		expect(usage.cost.cacheWrite).toBeCloseTo(0.375);
		expect(usage.cost.total).toBeCloseTo(3 + 7.5 + 0.6 + 0.375);
	});

	it("keeps base rates at the exact tier threshold", () => {
		const model = makeModel({
			cost: {
				input: 1,
				output: 2,
				cacheRead: 0.1,
				cacheWrite: 1.25,
				tiers: [{ inputTokensAbove: 100, input: 4, output: 6, cacheRead: 0.4, cacheWrite: 5 }],
			},
		});
		const usage = makeUsage({ input: 100, output: 1_000_000 });

		Model.calculateCost(model, usage);

		expect(usage.cost.input).toBeCloseTo(0.0001);
		expect(usage.cost.output).toBe(2);
	});

	it("uses the highest matching request-wide input pricing tier", () => {
		const model = makeModel({
			cost: {
				input: 1,
				output: 2,
				cacheRead: 0.1,
				cacheWrite: 1.25,
				tiers: [
					{ inputTokensAbove: 100, input: 2, output: 3, cacheRead: 0.2, cacheWrite: 2.5 },
					{ inputTokensAbove: 200, input: 4, output: 6, cacheRead: 0.4, cacheWrite: 5 },
				],
			},
		});
		const usage = makeUsage({ input: 100, output: 1_000_000, cacheRead: 101 });

		Model.calculateCost(model, usage);

		expect(usage.cost.input).toBeCloseTo(0.0004);
		expect(usage.cost.output).toBeCloseTo(6);
		expect(usage.cost.cacheRead).toBeCloseTo(0.0000404);
	});
});

describe("Model.clampThinkingLevel", () => {
	it("prefers the next higher supported level for disabled levels", () => {
		const model = makeModel({ reasoning: true, thinkingLevelMap: { medium: null } });
		expect(Model.clampThinkingLevel(model, "medium")).toBe("high");
	});

	it("skips consecutive disabled levels while preferring higher levels", () => {
		const model = makeModel({ reasoning: true, thinkingLevelMap: { low: null, medium: null } });
		expect(Model.clampThinkingLevel(model, "low")).toBe("high");
	});

	it("falls back to the next lower supported level when nothing higher exists", () => {
		const model = makeModel({ reasoning: true, thinkingLevelMap: { high: null } });
		expect(Model.clampThinkingLevel(model, "high")).toBe("medium");
	});
});
