import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT_MODELS_PATH } from "../utils/paths";
const ROOT_MODELS_JSON = readFileSync(ROOT_MODELS_PATH, "utf8");
const ROOT_MODELS = JSON.parse(ROOT_MODELS_JSON) as Record<
	string,
	{ id: string; api?: string; models: Record<string, unknown> }
>;

const importFetch = globalThis.fetch;
globalThis.fetch = (async () =>
	({
		ok: false,
		text: async () => "",
	}) satisfies Partial<Response> as Response) as unknown as typeof fetch;
const { ModelCatalog } = await import("../../src/model/catalog.ts");
globalThis.fetch = importFetch;

function resetCatalogCache(): void {
	ModelCatalog.modelsDevData.reset();
}

describe("ModelCatalog", () => {
	const originalModelsPath = process.env.CODEWORK_AIKIT_MODELS_PATH;
	const originalFetch = globalThis.fetch;
	let tempDir: string | undefined;

	beforeEach(() => {
		process.env.CODEWORK_AIKIT_MODELS_PATH = ROOT_MODELS_PATH;
		globalThis.fetch = originalFetch;
		resetCatalogCache();
	});

	afterEach(() => {
		process.env.CODEWORK_AIKIT_MODELS_PATH = originalModelsPath;
		globalThis.fetch = originalFetch;
		resetCatalogCache();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("get() reads models from CODEWORK_AIKIT_MODELS_PATH without fetching", async () => {
		globalThis.fetch = (() => {
			throw new Error("fetch should not be called when cache file exists");
		}) as unknown as typeof fetch;

		const catalog = await ModelCatalog.get();

		expect(catalog.anthropic).toBeDefined();
		expect(catalog.openai).toBeDefined();
		expect(catalog.anthropic?.id).toBe("anthropic");
		expect(catalog.openai?.id).toBe("openai");
	});

	it("refresh() writes fetched models to CODEWORK_AIKIT_MODELS_PATH and resets the cache", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "aikit-model-catalog-"));
		const tempModelsPath = join(tempDir, "models.json");
		writeFileSync(
			tempModelsPath,
			JSON.stringify({
				anthropic: {
					id: "anthropic",
					env: ["ANTHROPIC_API_KEY"],
					api: "https://stale.example.com/v1",
					name: "Anthropic",
					models: {},
				},
			}),
		);

		process.env.CODEWORK_AIKIT_MODELS_PATH = tempModelsPath;
		resetCatalogCache();

		let fetchCount = 0;
		globalThis.fetch = (async () => {
			fetchCount++;
			return {
				ok: true,
				text: async () => ROOT_MODELS_JSON,
			} as Response;
		}) as unknown as typeof fetch;

		const beforeRefresh = await ModelCatalog.get();
		expect(beforeRefresh.anthropic?.api).toBe("https://stale.example.com/v1");

		await ModelCatalog.refresh();

		const written = JSON.parse(readFileSync(tempModelsPath, "utf8")) as typeof beforeRefresh;
		expect(written.anthropic?.id).toBe("anthropic");
		expect(written.openai?.id).toBe("openai");

		const afterRefresh = await ModelCatalog.get();
		expect(afterRefresh.anthropic?.api).toBe(ROOT_MODELS.anthropic?.api);
		expect(Object.keys(afterRefresh.anthropic?.models ?? {}).length).toBe(
			Object.keys(ROOT_MODELS.anthropic?.models ?? {}).length,
		);
		expect(afterRefresh.openai?.id).toBe("openai");
		expect(fetchCount).toBeGreaterThanOrEqual(1);
	});
});
