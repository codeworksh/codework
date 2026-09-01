import Value from "typebox/value";
import { describe, expect, it } from "vite-plus/test";
import { generateModels as generateModelsImplementation, openAICodexBuiltInModels } from "../src/cli/modelgen.ts";
import * as Model from "../src/model/model.ts";
import { generateModels } from "../src/modelgen.ts";

describe("openAICodexBuiltInModels", () => {
	it("exposes catalog generation through the public modelgen entry", () => {
		expect(generateModels).toBe(generateModelsImplementation);
	});

	it("includes explicit Codex model list", () => {
		const models = openAICodexBuiltInModels();

		expect(Object.keys(models)).toEqual([
			"gpt-5.3-codex-spark",
			"gpt-5.4",
			"gpt-5.4-mini",
			"gpt-5.5",
			"gpt-5.6-luna",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
		]);
	});

	it("maps GPT-5.6 Codex metadata and reasoning levels", () => {
		const models = openAICodexBuiltInModels();

		for (const id of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] as const) {
			const model = models[id]!;
			expect(Value.Check(Model.Info, model)).toBe(true);
			expect(model).toMatchObject({
				id,
				contextWindow: 272_000,
				maxTokens: 128_000,
				protocol: "openai-codex",
				thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" },
				compat: { supportsToolSearch: true, supportsAdditionalTools: true },
			});
			expect(Model.getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
		}
	});

	it("maps Codex deferred-tool capability flags", () => {
		const models = openAICodexBuiltInModels();

		expect(models["gpt-5.3-codex-spark"]?.compat).toEqual({ supportsOpenAIGrammarTools: true });
		for (const id of ["gpt-5.4", "gpt-5.4-mini", "gpt-5.5"] as const) {
			expect(models[id]?.compat).toEqual({
				supportsOpenAIGrammarTools: true,
				supportsToolSearch: true,
			});
		}
		for (const id of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] as const) {
			expect(models[id]?.compat).toEqual({
				supportsOpenAIGrammarTools: true,
				supportsToolSearch: true,
				supportsAdditionalTools: true,
			});
		}
	});

	it("preserves current Codex pricing tiers", () => {
		const models = openAICodexBuiltInModels();

		expect(models["gpt-5.4"]?.cost.tiers).toEqual([
			{ inputTokensAbove: 272_000, input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 0 },
		]);
		expect(models["gpt-5.6-luna"]?.cost).toEqual({
			input: 0.2,
			output: 1.2,
			cacheRead: 0.02,
			cacheWrite: 0.25,
			tiers: [{ inputTokensAbove: 272_000, input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 }],
		});
		expect(models["gpt-5.6-sol"]?.cost.cacheWrite).toBe(6.25);
		expect(models["gpt-5.6-terra"]?.cost.input).toBe(2);
	});
});
