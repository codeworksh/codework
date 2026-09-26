import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import * as ModelCatalog from "../src/model/catalog.ts";
import * as Model from "../src/model/model.ts";

describe("Model.reloadCatalog", () => {
	const configuredPath = process.env.CODEWORK_MODELS_FILE;
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "aikit-catalog-"));
		delete process.env.CODEWORK_MODELS_FILE;
	});

	afterEach(async () => {
		if (configuredPath === undefined) delete process.env.CODEWORK_MODELS_FILE;
		else process.env.CODEWORK_MODELS_FILE = configuredPath;
		await rm(directory, { recursive: true, force: true });
	});

	it("re-reads a catalog that was missing or has since changed", async () => {
		const catalogPath = join(directory, "models.json");
		Model.configureCatalog(catalogPath);
		await expect(Model.getProviders()).rejects.toMatchObject({ name: "ModelCatalogLoadError" });

		await writeFile(catalogPath, JSON.stringify({ anthropic: {} }));
		Model.reloadCatalog();
		await expect(Model.getProviders()).resolves.toEqual(["anthropic"]);

		await writeFile(catalogPath, JSON.stringify({ anthropic: {}, openai: {} }));
		await expect(Model.getProviders()).resolves.toEqual(["anthropic"]);
		Model.reloadCatalog();
		await expect(Model.getProviders()).resolves.toEqual(["anthropic", "openai"]);
	});
});

describe("ModelCatalog.load", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "aikit-catalog-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("classifies invalid JSON and non-object values", async () => {
		for (const [filename, content] of [
			["syntax.json", "{"],
			["array.json", "[]"],
		] as const) {
			const catalogPath = join(directory, filename);
			await writeFile(catalogPath, content);

			await expect(ModelCatalog.load(catalogPath)).rejects.toMatchObject({
				name: "ModelCatalogLoadError",
				data: { path: catalogPath, reason: "invalid" },
			});
		}
	});
});
