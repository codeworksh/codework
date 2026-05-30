import { Filesystem, lazy } from "@codeworksh/utils";
import { resolve } from "node:path";
import { mapValues, pickBy, pipe } from "remeda";
import type { CommandModule } from "yargs";
import { DEFAULT_AI_SDK_PACKAGE, isAISDKPackage, protocolForPackage } from "../llm/registry";
import { ModelCatalog } from "../model/catalog";
import { Model } from "../model/model";

const DEFAULT_PROVIDER_BASE_URLS: Partial<Record<Model.KnownProviderEnum, string>> = {
	[Model.KnownProviderEnum.anthropic]: "https://api.anthropic.com/v1",
	[Model.KnownProviderEnum.openai]: "https://api.openai.com/v1",
	[Model.KnownProviderEnum.openrouter]: "https://openrouter.ai/api/v1",
	[Model.KnownProviderEnum.xai]: "https://api.x.ai/v1",
};

interface ModelsDevModel {
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
	provider?: {
		npm?: string;
		api?: string;
		headers?: Record<string, string>;
	};
}

interface ModelsDevProvider {
	id: string;
	env: string[];
	npm?: string;
	api?: string;
	name: string;
	doc?: string; // reference documentation link
	key?: string; // runtime placeholder for api/oauth key
	headers?: Record<string, string>; // custom overrides at provider level
	models: Record<string, ModelsDevModel>;
}

export type BuiltInModels = Partial<Record<string, Record<string, Model.Info>>>;

// Doesn't represent the full spec from models.dev.
// Represents the provider entries on a best-effort basis.
type ModelsDevCatalog = Record<string, ModelsDevProvider>;
type LazyModelsDevCatalog = ReturnType<typeof lazy<Promise<ModelsDevCatalog>>>;

function modelsDevURL(): string {
	return process.env.OPENCODE_MODELS_URL || "https://models.dev";
}

function modelsDevPath(): string | undefined {
	return process.env.OPENCODE_MODELS_DEV_FILE;
}

const modelsDevData: LazyModelsDevCatalog = lazy(async () => {
	const path = modelsDevPath();
	if (path) {
		const result = await Filesystem.readJson<ModelsDevCatalog>(path).catch(() => undefined);
		if (result) return result;
	}

	const json = await fetch(`${modelsDevURL()}/api.json`).then((x) => x.text());
	return JSON.parse(json) as ModelsDevCatalog;
});

async function pullModelsDevData(): Promise<ModelsDevCatalog> {
	return modelsDevData();
}

function toModelValue(providerId: string, provider: ModelsDevProvider, model: ModelsDevModel): Model.Info | undefined {
	return applyModification(providerId, provider, model);
}

async function loadBuiltInFromModelsDev() {
	const catalog = await pullModelsDevData();
	return pipe(
		catalog,
		pickBy((provider) =>
			Object.values(provider.models).some(
				(model) => Boolean(model.tool_call) && isAISDKPackage(resolveModelNpm(provider, model)),
			),
		),
		mapValues((provider, providerId) =>
			pipe(
				provider.models,
				pickBy((model) => Boolean(model.tool_call) && isAISDKPackage(resolveModelNpm(provider, model))),
				mapValues((model) => toModelValue(providerId, provider, model)),
				pickBy((model): model is Model.Info => model !== undefined),
			),
		),
	) as BuiltInModels;
}

type ThinkingLevelMap = NonNullable<Model.Info["thinkingLevelMap"]>;

function resolveModelNpm(provider: ModelsDevProvider, model: ModelsDevModel): string {
	return model.provider?.npm ?? provider.npm ?? DEFAULT_AI_SDK_PACKAGE;
}

function resolveModelBaseUrl(provider: ModelsDevProvider, model: ModelsDevModel): string {
	const npm = resolveModelNpm(provider, model);
	const protocol = protocolForPackage(npm);
	return model.baseUrl ?? model.provider?.api ?? provider.api ?? DEFAULT_PROVIDER_BASE_URLS[protocol] ?? "";
}

function resolveModelAPIMethod(npm: string): Model.APIMethodEnum {
	const protocol = protocolForPackage(npm);
	// `By default, xai(modelId) uses the Chat API.
	// To use the Responses API with server-side agentic tools, explicitly use xai.responses(modelId).`
	// References: https://ai-sdk.dev/providers/ai-sdk-providers/xai
	if (protocol === Model.KnownProviderEnum.openai || protocol === Model.KnownProviderEnum.xai) {
		return Model.APIMethodEnum.responses;
	}
	return Model.APIMethodEnum.languageModel;
}

function resolveProviderOptionsKey(protocol: Model.KnownProviderEnum): string {
	if (protocol === Model.KnownProviderEnum.openaiCompatible) return "openai-compatible";
	if (protocol === Model.KnownProviderEnum.googleVertex) return "google-vertex";
	if (protocol === Model.KnownProviderEnum.googleVertexAnthropic) return "google-vertex-anthropic";
	return protocol;
}

//
// adhoc helpers variations
const OPENAI_RESPONSES_NONE_REASONING_MODELS = new Set([
	"gpt-5.1",
	"gpt-5.2",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.5",
]);

function supportsOpenAiXhigh(modelId: string): boolean {
	return (
		modelId.includes("gpt-5.2") ||
		modelId.includes("gpt-5.3") ||
		modelId.includes("gpt-5.4") ||
		modelId.includes("gpt-5.5")
	);
}

function mergeThinkingLevelMap(model: Model.Info, map: ThinkingLevelMap): void {
	model.thinkingLevelMap = { ...model.thinkingLevelMap, ...map };
}

function applyThinkingLevelMetadata(model: Model.Info): void {
	if (model.protocol === Model.KnownProviderEnum.openai && model.id.startsWith("gpt-5")) {
		mergeThinkingLevelMap(model, { off: null });
	}
	if (
		model.protocol === Model.KnownProviderEnum.openai &&
		model.provider.id === "openai" &&
		OPENAI_RESPONSES_NONE_REASONING_MODELS.has(model.id)
	) {
		mergeThinkingLevelMap(model, { off: "none" });
	}
	if (supportsOpenAiXhigh(model.id)) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	}
	if (model.id.includes("opus-4-6") || model.id.includes("opus-4.6")) {
		mergeThinkingLevelMap(model, { xhigh: "max" });
	}
	if (model.id.includes("opus-4-7") || model.id.includes("opus-4.7")) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	}
}

export async function generateModels(args: { path?: string } = {}): Promise<string> {
	const path = resolve(args.path ?? ModelCatalog.path());
	const models = await loadBuiltInFromModelsDev();
	await Filesystem.writeJson(path, models);
	return path;
}

//
// CLI entry
export const ModelgenCommand: CommandModule<object, { path?: string }> = {
	command: "modelgen [path]",
	describe: "generate models.gen.json",
	builder: (yargs) =>
		yargs.positional("path", {
			type: "string",
			describe: "output path (defaults to CODEWORK_MODELS_FILE or ./models.gen.json)",
		}),
	handler: async (args) => {
		const path = await generateModels(args);
		console.log(`Generated model catalog at ${path}`);
	},
};

export function applyModification(
	providerId: string,
	provider: ModelsDevProvider,
	model: ModelsDevModel,
): Model.Info | undefined {
	const npm = resolveModelNpm(provider, model);
	if (!isAISDKPackage(npm)) return;

	const protocol = protocolForPackage(npm);
	const baseUrl = resolveModelBaseUrl(provider, model);
	const providerInfo: Model.ProviderInfo = {
		id: providerId,
		name: provider.name,
		source: "api",
		env: provider.env,
	};
	if (provider.key) providerInfo.key = provider.key;
	const api: Model.APIMetadata = {
		id: model.id,
		method: resolveModelAPIMethod(npm),
	};
	if (baseUrl) api.url = baseUrl;

	const info: Model.Info = {
		id: model.id,
		name: model.name,
		provider: providerInfo,
		baseUrl,
		reasoning: Boolean(model.reasoning),
		input: Model.normalizeInput(model.modalities.input),
		cost: {
			input: model.cost?.input ?? 0,
			output: model.cost?.output ?? 0,
			cacheRead: model.cost?.cache_read ?? 0,
			cacheWrite: model.cost?.cache_write ?? 0,
		},
		contextWindow: model.limit?.context ?? 4096,
		maxTokens: model.limit?.output ?? 4096,
		headers: {
			...provider.headers,
			...model.provider?.headers,
			...model.headers,
		},
		npm,
		api,
		providerOptionsKey: resolveProviderOptionsKey(protocol),
		protocol,
	};
	if (Object.keys(info.headers ?? {}).length === 0) delete info.headers;
	applyThinkingLevelMetadata(info);
	return info;
}
