import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import * as ModelCatalog from "../src/model/catalog.ts";

describe("ModelCatalog.path", () => {
	const configuredPath = process.env.CODEWORK_MODELS_FILE;

	afterEach(() => {
		if (configuredPath === undefined) delete process.env.CODEWORK_MODELS_FILE;
		else process.env.CODEWORK_MODELS_FILE = configuredPath;
	});

	it("resolves an explicit catalog path", () => {
		process.env.CODEWORK_MODELS_FILE = "fixtures/models.json";
		expect(ModelCatalog.path()).toBe(join(process.cwd(), "fixtures/models.json"));
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

	it("loads a generated catalog object", async () => {
		const catalogPath = join(directory, "models.json");
		const catalog = { anthropic: { "claude-test": { id: "claude-test" } } };
		await writeFile(catalogPath, JSON.stringify(catalog));

		await expect(ModelCatalog.load(catalogPath)).resolves.toEqual(catalog);
	});

	it("classifies a missing catalog", async () => {
		const catalogPath = join(directory, "missing.json");

		await expect(ModelCatalog.load(catalogPath)).rejects.toMatchObject({
			name: "ModelCatalogLoadError",
			data: {
				path: catalogPath,
				reason: "missing",
				message: `model catalog not found at ${catalogPath}`,
			},
		});
	});

	it("classifies an empty catalog", async () => {
		const catalogPath = join(directory, "empty.json");
		await writeFile(catalogPath, " \n\t");

		await expect(ModelCatalog.load(catalogPath)).rejects.toMatchObject({
			name: "ModelCatalogLoadError",
			data: { path: catalogPath, reason: "empty" },
		});
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
