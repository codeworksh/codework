import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Value from "typebox/value";
import { describe, expect, it } from "vite-plus/test";
import { generateModels as generateModelsImplementation, openAICodexBuiltInModels } from "../src/cli/modelgen.ts";
import * as Model from "../src/model/model.ts";
import { generateModels } from "../src/modelgen.ts";

const CODEX_MODEL_IDS = [
	"gpt-5.3-codex-spark",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
] as const;
const GPT_56_MODEL_IDS = ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] as const;

describe("openAICodexBuiltInModels", () => {
	it("exposes catalog generation through the public modelgen entry", () => {
		expect(generateModels).toBe(generateModelsImplementation);
	});

	it("includes explicit Codex model list", () => {
		const models = openAICodexBuiltInModels();

		expect(Object.keys(models)).toEqual(CODEX_MODEL_IDS);
	});

	it("produces valid metadata for every explicit Codex model", () => {
		const models = openAICodexBuiltInModels();

		for (const id of CODEX_MODEL_IDS) {
			const model = models[id]!;
			expect(Value.Check(Model.Info, model)).toBe(true);
			expect(model).toMatchObject({
				id,
				provider: { id: "openai-codex", source: "custom" },
				baseUrl: "https://chatgpt.com/backend-api",
				reasoning: true,
				maxTokens: 128_000,
				npm: "@codeworksh/ai-sdk-openai-codex",
				api: { id, method: "responses" },
				protocol: "openai-codex",
			});
		}
	});

	it("maps GPT-5.6 Codex metadata and reasoning levels", () => {
		const models = openAICodexBuiltInModels();

		for (const id of GPT_56_MODEL_IDS) {
			const model = models[id]!;
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
		for (const id of GPT_56_MODEL_IDS) {
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

describe("generateModels", () => {
	it("generates supported provider models and merges explicit Codex models", async () => {
		const directory = await mkdtemp(join(tmpdir(), "aikit-modelgen-"));
		const modelsDevPath = join(directory, "modelsdev.json");
		const outputPath = join(directory, "models.gen.json");
		const configuredModelsDevPath = process.env.OPENCODE_MODELS_DEV_FILE;
		const supportedModel = {
			id: "claude-test",
			name: "Claude Test",
			family: "claude",
			attachment: true,
			reasoning: true,
			tool_call: true,
			temperature: true,
			release_date: "2026-01-01",
			last_updated: "2026-01-01",
			modalities: { input: ["text", "image", "audio"], output: ["text"] },
			open_weights: false,
			cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
			limit: { context: 200_000, output: 8_192 },
		};

		try {
			await writeFile(
				modelsDevPath,
				JSON.stringify({
					anthropic: {
						id: "anthropic",
						name: "Anthropic",
						env: ["ANTHROPIC_API_KEY"],
						npm: "@ai-sdk/anthropic",
						api: "https://api.anthropic.com/v1",
						models: {
							"claude-test": supportedModel,
							"claude-without-tools": {
								...supportedModel,
								id: "claude-without-tools",
								name: "Claude Without Tools",
								tool_call: false,
							},
						},
					},
				}),
			);
			process.env.OPENCODE_MODELS_DEV_FILE = modelsDevPath;

			await expect(generateModels({ path: outputPath })).resolves.toBe(outputPath);
			const catalog = JSON.parse(await readFile(outputPath, "utf8")) as Model.BuiltInModels;
			const model = catalog.anthropic?.["claude-test"];

			expect(Value.Check(Model.Info, model)).toBe(true);
			expect(model).toMatchObject({
				id: "claude-test",
				provider: { id: "anthropic", source: "api", env: ["ANTHROPIC_API_KEY"] },
				baseUrl: "https://api.anthropic.com/v1",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200_000,
				maxTokens: 8_192,
				api: { id: "claude-test", method: "languageModel" },
				providerOptionsKey: "anthropic",
				protocol: "anthropic",
			});
			expect(catalog.anthropic?.["claude-without-tools"]).toBeUndefined();
			expect(Object.keys(catalog["openai-codex"] ?? {})).toEqual(CODEX_MODEL_IDS);
		} finally {
			if (configuredModelsDevPath === undefined) delete process.env.OPENCODE_MODELS_DEV_FILE;
			else process.env.OPENCODE_MODELS_DEV_FILE = configuredModelsDevPath;
			await rm(directory, { recursive: true, force: true });
		}
	});
});
