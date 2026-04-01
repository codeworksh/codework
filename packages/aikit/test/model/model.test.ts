import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCatalog as ModelCatalogNamespace } from "../../src/model/catalog.ts";
import { ROOT_MODELS_PATH } from "../utils/paths";
const importFetch = globalThis.fetch;
globalThis.fetch = (async () =>
	({
		ok: false,
		text: async () => "",
	}) as Response) as unknown as typeof fetch;
const { Model } = await import("../../src/model/model.ts");
const { ModelCatalog } = await import("../../src/model/catalog.ts");
globalThis.fetch = importFetch;

const ROOT_MODELS = JSON.parse(readFileSync(ROOT_MODELS_PATH, "utf8")) as Record<
	string,
	ModelCatalogNamespace.ModelsDevProvider
>;

function resetCatalogCache(): void {
	ModelCatalog.modelsDevData.reset();
}

function resetModelRegistry(): void {
	Model.registry.reset();
}

describe("Model", () => {
	const originalModelsPath = process.env.CODEWORK_AIKIT_MODELS_PATH;
	const originalFetch = globalThis.fetch;
	let tempDir: string | undefined;

	beforeEach(() => {
		process.env.CODEWORK_AIKIT_MODELS_PATH = ROOT_MODELS_PATH;
		globalThis.fetch = (() => {
			throw new Error("fetch should not be called when cache file exists");
		}) as unknown as typeof fetch;
		resetCatalogCache();
		resetModelRegistry();
	});

	afterEach(() => {
		process.env.CODEWORK_AIKIT_MODELS_PATH = originalModelsPath;
		globalThis.fetch = originalFetch;
		resetCatalogCache();
		resetModelRegistry();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("returns only built-in providers normalized to Model.Value records", async () => {
		const builtIns = await Model.getBuiltInModels();

		expect(Object.keys(builtIns).sort()).toEqual(["anthropic", "openai"]);
		expect("evroc" in builtIns).toBe(false);
	});

	it("normalizes anthropic models from models.json into Model.Schema shape", async () => {
		const builtIns = await Model.getBuiltInModels();
		const rawProvider = ROOT_MODELS.anthropic;
		expect(rawProvider).toBeDefined();
		if (!rawProvider) throw new Error("anthropic provider missing from models.json");

		const rawModel = rawProvider.models["claude-sonnet-4-5"];
		expect(rawModel).toBeDefined();
		if (!rawModel) throw new Error("claude-sonnet-4-5 missing from anthropic models");

		const normalized = builtIns.anthropic?.["claude-sonnet-4-5"];

		expect(normalized).toBeDefined();
		expect(normalized?.id).toBe(rawModel.id);
		expect(normalized?.name).toBe(rawModel.name);
		expect(normalized?.protocol).toBe(Model.KnownProtocolEnum.anthropicMessages);
		expect(normalized?.provider.id).toBe("anthropic");
		expect(normalized?.provider.name).toBe(rawProvider.name);
		expect(normalized?.provider.env).toEqual(rawProvider.env);
		expect(normalized?.baseUrl).toBe(rawModel.baseUrl ?? rawProvider.baseUrl ?? rawProvider.api);
		expect(normalized?.reasoning).toBe(Boolean(rawModel.reasoning));
		expect(normalized?.input).toEqual(["text", "image"]);
		expect(normalized?.cost).toEqual({
			input: rawModel.cost?.input ?? 0,
			output: rawModel.cost?.output ?? 0,
			cacheRead: rawModel.cost?.cache_read ?? 0,
			cacheWrite: rawModel.cost?.cache_write ?? 0,
		});
		expect(normalized?.contextWindow).toBe(rawModel.limit?.context ?? 0);
		expect(normalized?.maxTokens).toBe(rawModel.limit?.output ?? 0);
		expect(normalized?.headers).toBe(rawModel.headers ?? rawProvider.headers);
	});

	it("registry() resolves built-in providers into nested model maps", async () => {
		const registry = await Model.registry();
		const anthropic = registry.get("anthropic");
		const openai = registry.get("openai");

		expect(anthropic).toBeDefined();
		expect(openai).toBeDefined();
		expect(Array.from(registry.keys())).not.toContain("evroc");

		const anthropicModel = anthropic?.get("claude-sonnet-4-5");
		expect(anthropicModel).toBeDefined();
		expect(anthropicModel?.protocol).toBe(Model.KnownProtocolEnum.anthropicMessages);
		expect(anthropicModel?.provider.id).toBe("anthropic");
	});

	it("registry() caches the loaded map until reset is called", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "aikit-model-registry-"));
		const tempModelsPath = join(tempDir, "models.json");

		writeFileSync(
			tempModelsPath,
			JSON.stringify({
				anthropic: {
					id: "anthropic",
					env: ["ANTHROPIC_API_KEY"],
					api: "https://anthropic.example.com/v1",
					name: "Anthropic",
					models: {
						"claude-test-a": {
							id: "claude-test-a",
							name: "Claude Test A",
							family: "claude-sonnet",
							attachment: true,
							reasoning: true,
							modalities: { input: ["text", "image"], output: ["text"] },
							open_weights: false,
							release_date: "2026-01-01",
							last_updated: "2026-01-01",
							cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
							limit: { context: 1000, output: 2000 },
						},
					},
				},
				openai: {
					id: "openai",
					env: ["OPENAI_API_KEY"],
					api: "https://api.openai.example.com/v1",
					name: "OpenAI",
					models: {
						"gpt-test-a": {
							id: "gpt-test-a",
							name: "GPT Test A",
							family: "gpt",
							attachment: false,
							reasoning: true,
							modalities: { input: ["text"], output: ["text"] },
							open_weights: false,
							release_date: "2026-01-01",
							last_updated: "2026-01-01",
							cost: { input: 1, output: 2 },
							limit: { context: 1000, output: 2000 },
						},
					},
				},
			}),
		);

		process.env.CODEWORK_AIKIT_MODELS_PATH = tempModelsPath;
		resetCatalogCache();
		resetModelRegistry();

		const first = await Model.registry();
		expect(first.get("anthropic")?.has("claude-test-a")).toBe(true);

		writeFileSync(
			tempModelsPath,
			JSON.stringify({
				anthropic: {
					id: "anthropic",
					env: ["ANTHROPIC_API_KEY"],
					api: "https://anthropic.example.com/v1",
					name: "Anthropic",
					models: {
						"claude-test-b": {
							id: "claude-test-b",
							name: "Claude Test B",
							family: "claude-sonnet",
							attachment: true,
							reasoning: false,
							modalities: { input: ["text"], output: ["text"] },
							open_weights: false,
							release_date: "2026-01-02",
							last_updated: "2026-01-02",
							cost: { input: 3, output: 4 },
							limit: { context: 3000, output: 4000 },
						},
					},
				},
				openai: {
					id: "openai",
					env: ["OPENAI_API_KEY"],
					api: "https://api.openai.example.com/v1",
					name: "OpenAI",
					models: {},
				},
			}),
		);

		const cached = await Model.registry();
		expect(cached).toBe(first);
		expect(cached.get("anthropic")?.has("claude-test-a")).toBe(true);
		expect(cached.get("anthropic")?.has("claude-test-b")).toBe(false);

		resetCatalogCache();
		resetModelRegistry();

		const refreshed = await Model.registry();
		expect(refreshed).not.toBe(first);
		expect(refreshed.get("anthropic")?.has("claude-test-a")).toBe(false);
		expect(refreshed.get("anthropic")?.has("claude-test-b")).toBe(true);
	});

	it("getProviders() returns the built-in providers from the registry", async () => {
		const providers = await Model.getProviders();
		expect(providers.sort()).toEqual(["anthropic", "openai"]);
	});

	it("getModels() returns provider-scoped models from the registry", async () => {
		const models = await Model.getModels("anthropic");

		expect(models.length).toBeGreaterThan(0);
		expect(models.every((model) => model.provider.id === "anthropic")).toBe(true);
		expect(models.some((model) => model.id === "claude-sonnet-4-5")).toBe(true);
	});

	it("getModel() returns a specific model and undefined for missing entries", async () => {
		const model = await Model.getModel("anthropic", "claude-sonnet-4-5");
		expect(model?.id).toBe("claude-sonnet-4-5");
		expect(model?.provider.id).toBe("anthropic");
		expect(model?.protocol).toBe(Model.KnownProtocolEnum.anthropicMessages);

		const missing = await Model.getModel("anthropic", "does-not-exist" as string);
		expect(missing).toBeUndefined();
	});

	it("supportsXhigh() and modelsAreEqual() use normalized model identity correctly", async () => {
		const gpt5 = await Model.getModel("openai", "gpt-5");
		const claude = await Model.getModel("anthropic", "claude-sonnet-4-5");

		expect(gpt5).toBeDefined();
		expect(claude).toBeDefined();
		if (!gpt5 || !claude) throw new Error("expected openai and anthropic models to exist");

		expect(Model.supportsXhigh(gpt5)).toBe(true);
		expect(Model.supportsXhigh(claude)).toBe(false);
		expect(Model.modelsAreEqual(gpt5, gpt5)).toBe(true);
		expect(Model.modelsAreEqual(gpt5, claude)).toBe(false);
		expect(Model.modelsAreEqual(gpt5, undefined)).toBe(false);
	});
});
