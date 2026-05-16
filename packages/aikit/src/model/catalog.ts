import { Filesystem, lazy } from "@codeworksh/utils";
import Type, { type Static } from "typebox";

export namespace ModelCatalog {
	// known protocols
	// each protocol has protocol implementation
	export const KnownProtocolEnum = {
		anthropicMessages: "anthropic-messages",
		openaiCompletions: "openai-completions",
		openaiResponses: "openai-responses",
	} as const;
	export const KnownProtocolEnumSchema = Type.Union([
		Type.Literal(KnownProtocolEnum.anthropicMessages),
		Type.Literal(KnownProtocolEnum.openaiCompletions),
		Type.Literal(KnownProtocolEnum.openaiResponses),
	]);
	export type KnownProtocolEnum = Static<typeof KnownProtocolEnumSchema>;

	// known providers
	// each provider supports atleast a protocol implementation direct or with compat flags
	export const KnownProviderEnum = {
		anthropic: "anthropic",
		openai: "openai",
		githubCopilot: "github-copilot",
		openrouter: "openrouter",
		groq: "groq",
		xai: "xai",
		cerebras: "cerebras",
		zai: "zai",
		opencode: "opencode",
	} as const;
	export const KnownProviderEnumSchema = Type.Union([
		Type.Literal(KnownProviderEnum.anthropic),
		Type.Literal(KnownProviderEnum.openai),
		Type.Literal(KnownProviderEnum.githubCopilot),
		Type.Literal(KnownProviderEnum.openrouter),
		Type.Literal(KnownProviderEnum.groq),
		Type.Literal(KnownProviderEnum.xai),
		Type.Literal(KnownProviderEnum.cerebras),
		Type.Literal(KnownProviderEnum.zai),
		Type.Literal(KnownProviderEnum.opencode),
	]);
	export type KnownProviderEnum = Static<typeof KnownProviderEnumSchema>;

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
		structured_output?: boolean;
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
	// Doesn't represent the full spec from models.dev.
	// Represents the provider entries on a best-effort basis.
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

	void ModelCatalog.refresh();
	setInterval(
		async () => {
			await ModelCatalog.refresh();
		},
		60 * 1000 * 60,
	).unref();
}
