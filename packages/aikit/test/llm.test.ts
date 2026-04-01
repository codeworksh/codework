import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ROOT_MODELS_PATH } from "./utils/paths";
const importFetch = globalThis.fetch;
globalThis.fetch = (async () =>
	({
		ok: false,
		text: async () => "",
	}) as Response) as unknown as typeof fetch;
const { llm } = await import("../src/llm.ts");
const { Model } = await import("../src/model/model.ts");
const { ModelCatalog } = await import("../src/model/catalog.ts");
globalThis.fetch = importFetch;

describe("llm", () => {
	const originalModelsPath = process.env.CODEWORK_AIKIT_MODELS_PATH;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		process.env.CODEWORK_AIKIT_MODELS_PATH = ROOT_MODELS_PATH;
		globalThis.fetch = (() => {
			throw new Error("fetch should not be called when cache file exists");
		}) as unknown as typeof fetch;
		ModelCatalog.modelsDevData.reset();
		Model.registry.reset();
	});

	afterEach(() => {
		process.env.CODEWORK_AIKIT_MODELS_PATH = originalModelsPath;
		globalThis.fetch = originalFetch;
		ModelCatalog.modelsDevData.reset();
		Model.registry.reset();
	});

	it("is callable and resolves the same model as Model.getModel()", async () => {
		const viaFacade = await llm("anthropic", "claude-sonnet-4-5");
		const viaModel = await Model.getModel("anthropic", "claude-sonnet-4-5");

		expect(viaFacade).toEqual(viaModel);
	});

	it("exposes the registry-backed model helpers", async () => {
		expect(await llm.providers()).toEqual(await Model.getProviders());
		expect(await llm.models("openai")).toEqual(await Model.getModels("openai"));
		expect(await llm.registry()).toEqual(await Model.registry());

		const gpt5 = await llm("openai", "gpt-5");
		expect(gpt5).toBeDefined();
		if (!gpt5) throw new Error("expected gpt-5 model to exist");

		expect(llm.supportsXhigh(gpt5)).toBe(true);
		expect(llm.modelsAreEqual(gpt5, gpt5)).toBe(true);
	});
});
