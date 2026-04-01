import { Filesystem, lazy } from "@codeworksh/buntils";

export namespace ModelCatalog {
	// Doesn't represent the full spec from models.dev.
	// Represents the provider entry on a best-effort basis.
	export interface ModelsDevModel {
		id: string;
		name: string;
		family: string;
		attachment: boolean;
		reasoning?: boolean;
		tool_call?: boolean;
		temperature?: boolean;
		knowledge?: string | boolean;
		release_date: string;
		last_updated: string;
		modalities: {
			input?: string[];
			output: string[];
		};
		open_weights: boolean;
		baseUrl?: string;
		headers?: Record<string, string>;
		cost?: {
			input?: number;
			output?: number;
			cache_read?: number;
			cache_write?: number;
		};
		limit?: {
			context?: number;
			output?: number;
		};
	}

	export interface ModelsDevProvider {
		id: string;
		env: string[];
		npm?: string;
		api: string;
		baseUrl?: string;
		name: string;
		doc?: string;
		key?: string;
		headers?: Record<string, string>;
		models: Record<string, ModelsDevModel>;
	}
	export type ModelsDevCatalog = Record<string, ModelsDevProvider>;
	type LazyModelsDevCatalog = ReturnType<typeof lazy<Promise<ModelsDevCatalog>>>;

	function modelsDevURL(): string {
		return process.env.OPENCODE_MODELS_URL || "https://models.dev";
	}

	function modelsDevPath(): string | undefined {
		return process.env.CODEWORK_AIKIT_MODELS_PATH;
	}

	export const modelsDevData: LazyModelsDevCatalog = lazy(async () => {
		const path = modelsDevPath();
		if (path) {
			const result = await Filesystem.readJson<ModelsDevCatalog>(path).catch(() => undefined);
			if (result) return result;
		}

		const json = await fetch(`${modelsDevURL()}/api.json`).then((x) => x.text());
		return JSON.parse(json) as ModelsDevCatalog;
	});

	export async function get(): Promise<ModelsDevCatalog> {
		return modelsDevData();
	}

	export async function refresh(): Promise<void> {
		const result = await fetch(`${modelsDevURL()}/api.json`, {
			signal: AbortSignal.timeout(10 * 1000),
		}).catch(() => undefined);
		if (!result?.ok) return;

		const json = await result.text();
		const path = modelsDevPath();
		if (path) {
			await Filesystem.write(path, json);
		}
		modelsDevData.reset();
	}

	ModelCatalog.refresh();
	setInterval(
		async () => {
			await ModelCatalog.refresh();
		},
		60 * 1000 * 60,
	).unref();
}
