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

	it("yields zero cost for free models", () => {
		const model = makeModel();
		const usage = makeUsage({ input: 1_000_000, output: 1_000_000 });

		Model.calculateCost(model, usage);
		expect(usage.cost.total).toBe(0);
	});

	it("keeps decimal precision for large token counts", () => {
		const model = makeModel({ cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 } });
		const usage = makeUsage({
			input: 9_876_543_210,
			output: 1_234_567_890,
			cacheRead: 2_222_222_222,
			cacheWrite: 3_333_333_333,
		});

		Model.calculateCost(model, usage);

		expect(usage.cost.input).toBeCloseTo(1_975.308642, 10);
		expect(usage.cost.output).toBeCloseTo(1_481.481468, 10);
		expect(usage.cost.cacheRead).toBeCloseTo(44.44444444, 10);
		expect(usage.cost.cacheWrite).toBeCloseTo(833.33333325, 10);
		expect(usage.cost.total).toBeCloseTo(4_334.56788769, 10);
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

describe("Model.normalizeInput", () => {
	it("defaults to text when input is missing or empty", () => {
		expect(Model.normalizeInput()).toEqual(["text"]);
		expect(Model.normalizeInput([])).toEqual(["text"]);
	});

	it("keeps known modalities and drops unknown ones", () => {
		expect(Model.normalizeInput(["text", "image", "audio", "video"])).toEqual(["text", "image"]);
	});

	it("deduplicates modalities", () => {
		expect(Model.normalizeInput(["text", "text", "image", "image"])).toEqual(["text", "image"]);
	});

	// FIXME: no fallback to known modalities; keep what's only supported.
	it("falls back to text when only unknown modalities are given", () => {
		expect(Model.normalizeInput(["audio"])).toEqual(["text"]);
	});
});

describe("Model.supportsProtocol", () => {
	it("matches the model's native protocol", () => {
		expect(Model.supportsProtocol(makeModel({ protocol: "anthropic" }), "anthropic")).toBe(true);
		expect(Model.supportsProtocol(makeModel({ protocol: "anthropic" }), "openai")).toBe(false);
	});

	it("matches protocols listed in supportedProtocols", () => {
		const model = makeModel({ protocol: "openai", supportedProtocols: { openaiCompatible: "openai-compatible" } });
		expect(Model.supportsProtocol(model, "openai-compatible")).toBe(true);
		expect(Model.supportsProtocol(model, "anthropic")).toBe(false);
	});
});

describe("Model.modelsAreEqual", () => {
	it("returns false when either side is missing", () => {
		expect(Model.modelsAreEqual(undefined, makeModel())).toBe(false);
		expect(Model.modelsAreEqual(makeModel(), null)).toBe(false);
	});

	it("compares by model id and provider id", () => {
		const a = makeModel();
		expect(Model.modelsAreEqual(a, makeModel())).toBe(true);
		expect(Model.modelsAreEqual(a, makeModel({ id: "different" }))).toBe(false);
		expect(
			Model.modelsAreEqual(a, makeModel({ provider: { id: "other", name: "Other", source: "custom", env: [] } })),
		).toBe(false);
	});
});

describe("Model.getSupportedThinkingLevels", () => {
	it("returns only off for non-reasoning models", () => {
		expect(Model.getSupportedThinkingLevels(makeModel({ reasoning: false }))).toEqual(["off"]);
	});

	it("excludes xhigh by default for reasoning models", () => {
		expect(Model.getSupportedThinkingLevels(makeModel({ reasoning: true }))).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
		]);
	});

	it("includes xhigh when the model maps it explicitly", () => {
		const model = makeModel({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } });
		expect(Model.getSupportedThinkingLevels(model)).toContain("xhigh");
	});

	it("includes max only when the model maps it explicitly", () => {
		expect(Model.getSupportedThinkingLevels(makeModel({ reasoning: true }))).not.toContain("max");
		const model = makeModel({ reasoning: true, thinkingLevelMap: { max: "max" } });
		expect(Model.getSupportedThinkingLevels(model)).toContain("max");
	});

	it("excludes levels mapped to null", () => {
		const model = makeModel({ reasoning: true, thinkingLevelMap: { minimal: null, low: null } });
		expect(Model.getSupportedThinkingLevels(model)).toEqual(["off", "medium", "high"]);
	});
});

describe("Model.clampThinkingLevel", () => {
	it("returns the level itself when supported", () => {
		const model = makeModel({ reasoning: true });
		expect(Model.clampThinkingLevel(model, "medium")).toBe("medium");
		expect(Model.clampThinkingLevel(model, "off")).toBe("off");
	});

	it("clamps any level to off for non-reasoning models", () => {
		const model = makeModel({ reasoning: false });
		expect(Model.clampThinkingLevel(model, "xhigh")).toBe("off");
		expect(Model.clampThinkingLevel(model, "low")).toBe("off");
	});

	it("clamps unsupported xhigh down to high", () => {
		const model = makeModel({ reasoning: true });
		expect(Model.clampThinkingLevel(model, "xhigh")).toBe("high");
	});

	it("clamps unsupported max down to high", () => {
		const model = makeModel({ reasoning: true });
		expect(Model.clampThinkingLevel(model, "max")).toBe("high");
	});

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
