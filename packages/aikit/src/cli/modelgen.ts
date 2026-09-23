import { resolve } from "node:path";
import { mapValues, pickBy, pipe } from "remeda";
import type { CommandModule } from "yargs";
import { DEFAULT_AI_SDK_FALLBACK, isAISDKPackage, protocolForPackage } from "../llm/registry.ts";
import * as ModelCatalog from "../model/catalog.ts";
import * as Model from "../model/model.ts";
import { GITHUB_COPILOT_STATIC_HEADERS } from "../providers/github-copilot/copilot-headers.ts";
import * as Filesystem from "../utils/filesystem.ts";

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
		tiers?: Array<{
			input?: number;
			output?: number;
			cache_read?: number;
			cache_write?: number;
			tier?: { type?: string; size?: number };
		}>;
	};
	reasoning_options?: Array<{
		type?: string;
		values?: string[];
		min?: number;
		max?: number;
	}>;
	status?: string;
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

export type BuiltInModels = Model.BuiltInModels;

// Doesn't represent the full spec from models.dev.
// Represents the provider entries on a best-effort basis.
type ModelsDevCatalog = Record<string, ModelsDevProvider>;

function modelsDevURL(): string {
	return process.env.OPENCODE_MODELS_URL || "https://models.dev";
}

function modelsDevPath(): string | undefined {
	return process.env.OPENCODE_MODELS_DEV_FILE;
}

async function pullModelsDevData(): Promise<ModelsDevCatalog> {
	const path = modelsDevPath();
	if (path) {
		const result = await Filesystem.readJson<ModelsDevCatalog>(path).catch(() => undefined);
		if (result) return result;
	}

	const response = await fetch(`${modelsDevURL()}/api.json`);
	if (!response.ok) throw new Error(`models.dev responded ${response.status} ${response.statusText}`);
	return (await response.json()) as ModelsDevCatalog;
}

function toModelValue(providerId: string, provider: ModelsDevProvider, model: ModelsDevModel): Model.Info | undefined {
	return applyModification(providerId, provider, model);
}

function loadBuiltInFromModelsDev(catalog: ModelsDevCatalog) {
	return pipe(
		catalog,
		pickBy((provider) =>
			Object.values(provider.models).some(
				// If `resolveModelNpm` fallbacks to `@ai-sdk/openai-compatible`
				// isAISDKPakage will be truthy, modify resolveModelNpm for custom logic if needed.
				// Keep `isAISDKPackage` as readonly for supported implemenatations key check
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
	return model.provider?.npm ?? provider.npm ?? DEFAULT_AI_SDK_FALLBACK;
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

function supportsOpenAiXhigh(model: Model.Info): boolean {
	const modelId = model.id;
	return (
		modelId.includes("gpt-5.2") ||
		modelId.includes("gpt-5.3") ||
		modelId.includes("gpt-5.4") ||
		modelId.includes("gpt-5.5") ||
		(model.protocol === Model.KnownProviderEnum.openaiCodex && modelId.includes("gpt-5.6"))
	);
}

function supportsOpenAiCodexMax(model: Model.Info): boolean {
	return model.protocol === Model.KnownProviderEnum.openaiCodex && model.id.includes("gpt-5.6");
}

function mergeThinkingLevelMap(model: Model.Info, map: ThinkingLevelMap): void {
	model.thinkingLevelMap = { ...model.thinkingLevelMap, ...map };
}

function mergeCompat(model: Model.Info, compat: Model.Compatibility): void {
	model.compat = { ...model.compat, ...compat };
}

function applyGoogleThinkingMetadata(model: Model.Info): void {
	const id = model.id.toLowerCase();
	const supportsThinkingLevel =
		/gemini-3(?:\.\d+)?-(?:pro|flash)|gemma-?4/.test(id) ||
		id === "gemini-flash-latest" ||
		id === "gemini-flash-lite-latest";
	mergeCompat(model, { supportsThinkingLevel });
	if (supportsThinkingLevel) return;

	// Unknown budget-based families ask the provider to size thinking dynamically.
	const defaults: Array<[string, Model.ThinkingBudgets]> = [
		["2.5-pro", { minimal: 128, low: 2048, medium: 8192, high: 32768 }],
		["2.5-flash-lite", { minimal: 512, low: 2048, medium: 8192, high: 24576 }],
		["2.5-flash", { minimal: 128, low: 2048, medium: 8192, high: 24576 }],
	];
	model.thinkingBudgets = defaults.find(([family]) => id.includes(family))?.[1] ?? {
		minimal: -1,
		low: -1,
		medium: -1,
		high: -1,
	};
}

function applyModelMetadata(model: Model.Info): void {
	if (model.protocol === Model.KnownProviderEnum.google || model.protocol === Model.KnownProviderEnum.googleVertex) {
		applyGoogleThinkingMetadata(model);
	}
	if (model.protocol === Model.KnownProviderEnum.openai || model.protocol === Model.KnownProviderEnum.openaiCodex) {
		model.cost.serviceTierMultipliers = { flex: 0.5, priority: model.id === "gpt-5.5" ? 2.5 : 2 };
	}
	if (
		(model.protocol === Model.KnownProviderEnum.google || model.protocol === Model.KnownProviderEnum.googleVertex) &&
		/gemini-3(?:\.\d+)?-pro|gemini-3\.[78]-flash/.test(model.id.toLowerCase())
	) {
		// These models cannot disable thinking or accept minimal. Expose supported
		// levels to callers and let the shared clamp promote minimal to low.
		mergeThinkingLevelMap(model, { off: "low", minimal: null });
	}
	if (
		(model.protocol === Model.KnownProviderEnum.anthropic ||
			model.protocol === Model.KnownProviderEnum.googleVertexAnthropic) &&
		Model.isAnthropicAdaptiveThinkingModel(model.id)
	) {
		mergeCompat(model, { forceAdaptiveThinking: true });
	}
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
	if (supportsOpenAiXhigh(model)) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	}
	if (supportsOpenAiCodexMax(model)) {
		mergeThinkingLevelMap(model, { max: "max" });
	}
	if (model.id.includes("opus-4-6") || model.id.includes("opus-4.6")) {
		mergeThinkingLevelMap(model, { xhigh: "max" });
	}
	if (model.id.includes("opus-4-7") || model.id.includes("opus-4.7")) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	}
}

//
// OpenAI Codex (ChatGPT OAuth) models.
// NOTE: These are not fetched from models.dev; we keep a small, explicit list to avoid aliases.
// Context window is based on observed server limits (400s above ~272k), not marketing numbers.
const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const OPENAI_CODEX_NPM = "@codeworksh/ai-sdk-openai-codex";
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_CODEX_CONTEXT = 272_000;
const OPENAI_CODEX_GPT_56_CONTEXT = 272_000;
const OPENAI_CODEX_SPARK_CONTEXT = 128_000;
const OPENAI_CODEX_MAX_TOKENS = 128_000;
const OPENAI_LONG_CONTEXT_INPUT_THRESHOLD = 272_000;
const OPENAI_CODEX_TOOL_SEARCH_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
]);
const OPENAI_CODEX_ADDITIONAL_TOOLS_MODEL_IDS = new Set(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]);

type OpenAICodexModelSeed = Pick<Model.Info, "id" | "name" | "input" | "cost" | "contextWindow" | "thinkingLevelMap">;

function roundCost(value: number): number {
	return Number(value.toFixed(6));
}

function withOpenAiLongContextPricing(cost: Model.Info["cost"]): Model.Info["cost"] {
	return {
		...cost,
		tiers: [
			{
				inputTokensAbove: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
				input: roundCost(cost.input * 2),
				output: roundCost(cost.output * 1.5),
				cacheRead: roundCost(cost.cacheRead * 2),
				cacheWrite: roundCost(cost.cacheWrite * 2),
			},
		],
	};
}

const OPENAI_CODEX_GPT_56_COSTS = {
	"gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
	"gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
} satisfies Record<string, Model.Info["cost"]>;

const OPENAI_CODEX_MODELS: OpenAICodexModelSeed[] = [
	{
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		input: ["text"],
		cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
		contextWindow: OPENAI_CODEX_SPARK_CONTEXT,
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		input: ["text", "image"],
		cost: withOpenAiLongContextPricing({ input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 }),
		contextWindow: OPENAI_CODEX_CONTEXT,
	},
	{
		id: "gpt-5.4-mini",
		name: "GPT-5.4 mini",
		input: ["text", "image"],
		cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
		contextWindow: OPENAI_CODEX_CONTEXT,
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		input: ["text", "image"],
		cost: withOpenAiLongContextPricing({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 }),
		contextWindow: OPENAI_CODEX_CONTEXT,
	},
	{
		id: "gpt-5.6-luna",
		name: "GPT-5.6 Luna",
		input: ["text", "image"],
		cost: withOpenAiLongContextPricing(OPENAI_CODEX_GPT_56_COSTS["gpt-5.6-luna"]),
		contextWindow: OPENAI_CODEX_GPT_56_CONTEXT,
		thinkingLevelMap: { minimal: null },
	},
	{
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		input: ["text", "image"],
		cost: withOpenAiLongContextPricing({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }),
		contextWindow: OPENAI_CODEX_GPT_56_CONTEXT,
		thinkingLevelMap: { minimal: null },
	},
	{
		id: "gpt-5.6-terra",
		name: "GPT-5.6 Terra",
		input: ["text", "image"],
		cost: withOpenAiLongContextPricing(OPENAI_CODEX_GPT_56_COSTS["gpt-5.6-terra"]),
		contextWindow: OPENAI_CODEX_GPT_56_CONTEXT,
		thinkingLevelMap: { minimal: null },
	},
];

export function openAICodexBuiltInModels(): Record<string, Model.Info> {
	const models: Record<string, Model.Info> = {};
	for (const seed of OPENAI_CODEX_MODELS) {
		const supportsToolSearch = OPENAI_CODEX_TOOL_SEARCH_MODEL_IDS.has(seed.id);
		const supportsAdditionalTools = OPENAI_CODEX_ADDITIONAL_TOOLS_MODEL_IDS.has(seed.id);
		const info: Model.Info = {
			...seed,
			provider: {
				id: OPENAI_CODEX_PROVIDER_ID,
				name: "OpenAI Codex (ChatGPT)",
				source: "custom",
				env: ["OPENAI_CODEX_API_KEY"],
			},
			baseUrl: OPENAI_CODEX_BASE_URL,
			reasoning: true,
			// Codex models always reason; the off level cannot be requested.
			thinkingLevelMap: { off: null, ...seed.thinkingLevelMap },
			maxTokens: OPENAI_CODEX_MAX_TOKENS,
			npm: OPENAI_CODEX_NPM,
			api: {
				id: seed.id,
				url: OPENAI_CODEX_BASE_URL,
				method: Model.APIMethodEnum.responses,
			},
			providerOptionsKey: OPENAI_CODEX_PROVIDER_ID,
			compat: {
				supportsOpenAIGrammarTools: true,
				...(supportsToolSearch ? { supportsToolSearch: true } : {}),
				...(supportsAdditionalTools ? { supportsAdditionalTools: true } : {}),
			},
			protocol: Model.KnownProviderEnum.openaiCodex,
		};
		applyModelMetadata(info);
		models[seed.id] = info;
	}
	return models;
}

//
// GitHub Copilot models.
// Sourced from models.dev, then rewritten onto the bundled provider: one
// `github-copilot` protocol whose `api.method` selects between Chat
// Completions, Responses, and Anthropic Messages.
const GITHUB_COPILOT_PROVIDER_ID = "github-copilot";
const GITHUB_COPILOT_NPM = "@codeworksh/ai-sdk-github-copilot";
const GITHUB_COPILOT_BASE_URL = "https://api.githubcopilot.com";
const GITHUB_COPILOT_EXTENDED_CONTEXT = 1_000_000;

// GitHub's "Models with extended capabilities" table lists these Copilot
// models as supporting the extended 1 million token context window (pi).
const GITHUB_COPILOT_EXTENDED_CONTEXT_MODELS = new Set([
	"claude-fable-5",
	"claude-opus-4.6",
	"claude-opus-4.7",
	"claude-opus-4.8",
	"claude-opus-5",
	"claude-sonnet-4.6",
	"claude-sonnet-5",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.5",
]);

// Checked manually against the authenticated GitHub Copilot /models endpoint
// (pi). Narrow corrections over models.dev metadata, not a catalog snapshot.
const GITHUB_COPILOT_THINKING_LEVEL_OVERRIDES: Record<string, ThinkingLevelMap> = {
	"claude-opus-4.7": { minimal: "low" },
	"claude-opus-4.8": { minimal: "low" },
	"claude-opus-5": { minimal: "low" },
	"claude-sonnet-4.6": { minimal: "low", max: "max" },
};

/**
 * The offline routing approximation (pi). The live `/models` response's
 * `supported_endpoints` is authoritative at runtime.
 *
 * - `claude-(haiku|sonnet|opus|fable)-[45]` → Anthropic Messages
 * - `gpt-*`, `grok-*`, `oswe*`, `mai-*` → OpenAI Responses
 * - everything else → OpenAI Chat Completions
 */
export function githubCopilotApiMethod(modelId: string): Model.APIMethodEnum {
	if (/^claude-(haiku|sonnet|opus|fable)-[45]([.-]|$)/.test(modelId)) {
		return Model.APIMethodEnum.messages;
	}
	const gpt = /^gpt-(\d+)/.exec(modelId);
	if (
		(gpt !== null && Number(gpt[1]) >= 5) ||
		modelId.startsWith("grok-") ||
		modelId.startsWith("oswe") ||
		modelId.startsWith("mai-")
	) {
		return Model.APIMethodEnum.responses;
	}
	return Model.APIMethodEnum.chat;
}

/** Effort values models.dev advertises for a model, when it lists any. */
function githubCopilotEffortValues(model: ModelsDevModel): Set<string> | undefined {
	for (const option of model.reasoning_options ?? []) {
		if (option.type === "effort" && Array.isArray(option.values)) return new Set(option.values);
	}
	return undefined;
}

/**
 * Derive the level map from models.dev `reasoning_options`: a level maps to
 * itself only when the endpoint actually advertises it. `minimal` degrades to
 * `low` — the lowest effort every reasoning model accepts.
 */
function githubCopilotThinkingLevels(model: ModelsDevModel, method: Model.APIMethodEnum): ThinkingLevelMap | undefined {
	const efforts = githubCopilotEffortValues(model);
	const map: ThinkingLevelMap = {};
	// Copilot rejects `reasoningEffort: "none"` (pi), and the chat route has no
	// reasoning control, so only Messages models can disable thinking.
	if (method !== Model.APIMethodEnum.messages) map.off = null;
	if (!efforts) return Object.keys(map).length > 0 ? map : undefined;

	if (efforts.has("minimal")) map.minimal = "minimal";
	else if (efforts.has("low")) map.minimal = "low";
	for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
		map[level] = efforts.has(level) ? level : null;
	}
	return map;
}

function githubCopilotCostTiers(model: ModelsDevModel): Model.Info["cost"]["tiers"] | undefined {
	const tiers = model.cost?.tiers?.flatMap((tier) => {
		const context = tier.tier;
		if (context?.type !== "context" || context.size === undefined) return [];
		return [
			{
				inputTokensAbove: context.size,
				input: tier.input ?? 0,
				output: tier.output ?? 0,
				cacheRead: tier.cache_read ?? 0,
				cacheWrite: tier.cache_write ?? 0,
			},
		];
	});
	return tiers && tiers.length > 0 ? tiers : undefined;
}

export function githubCopilotBuiltInModels(provider: ModelsDevProvider | undefined): Record<string, Model.Info> {
	const models: Record<string, Model.Info> = {};
	if (!provider) return models;
	for (const [id, source] of Object.entries(provider.models)) {
		if (source.tool_call !== true) continue;
		if (source.status === "deprecated") continue;
		// The chat-latest alias races the Responses route for gpt-5 models.
		if (id === "gpt-5-chat-latest") continue;

		const base = applyModification(GITHUB_COPILOT_PROVIDER_ID, provider, source);
		if (!base) continue;

		const method = githubCopilotApiMethod(id);
		const tiers = githubCopilotCostTiers(source);
		const info: Model.Info = {
			...base,
			provider: {
				id: GITHUB_COPILOT_PROVIDER_ID,
				name: "GitHub Copilot",
				source: "custom",
				env: ["COPILOT_GITHUB_TOKEN"],
			},
			baseUrl: GITHUB_COPILOT_BASE_URL,
			headers: { ...GITHUB_COPILOT_STATIC_HEADERS },
			cost: { ...base.cost, ...(tiers ? { tiers } : {}) },
			npm: GITHUB_COPILOT_NPM,
			api: { id, url: GITHUB_COPILOT_BASE_URL, method },
			providerOptionsKey: GITHUB_COPILOT_PROVIDER_ID,
			protocol: Model.KnownProviderEnum.githubCopilot,
			// Copilot's Responses route requires store=false + encrypted reasoning
			// content for thinking to round-trip.
			...(method === Model.APIMethodEnum.responses
				? {
						providerOptions: {
							...base.providerOptions,
							[GITHUB_COPILOT_PROVIDER_ID]: {
								store: false,
								include: ["reasoning.encrypted_content"],
							},
						},
					}
				: {}),
		};

		if (GITHUB_COPILOT_EXTENDED_CONTEXT_MODELS.has(id)) info.contextWindow = GITHUB_COPILOT_EXTENDED_CONTEXT;
		if (method === Model.APIMethodEnum.messages && Model.isAnthropicAdaptiveThinkingModel(id)) {
			mergeCompat(info, { forceAdaptiveThinking: true });
		}
		// Copilot's Responses endpoint passes OpenAI custom grammar tools through
		// for GPT-5+ (verified by pi).
		const gpt = /^gpt-(\d+)/.exec(id);
		if (method === Model.APIMethodEnum.responses && gpt !== null && Number(gpt[1]) >= 5) {
			mergeCompat(info, { supportsOpenAIGrammarTools: true });
		}
		if (id.startsWith("gpt-5")) mergeThinkingLevelMap(info, { off: null, minimal: "low" });
		if (id.includes("fable-5")) mergeThinkingLevelMap(info, { off: null, xhigh: "xhigh", max: "max" });

		const levels = githubCopilotThinkingLevels(source, method);
		if (levels) mergeThinkingLevelMap(info, levels);
		const override = GITHUB_COPILOT_THINKING_LEVEL_OVERRIDES[id];
		if (override) mergeThinkingLevelMap(info, override);

		models[id] = info;
	}
	return models;
}

export async function generateModels(args: { path?: string | undefined } = {}): Promise<string> {
	const path = resolve(args.path ?? ModelCatalog.path());
	const catalog = await pullModelsDevData();
	const modelsDev = loadBuiltInFromModelsDev(catalog);
	const customCodexModels = openAICodexBuiltInModels();
	const copilotProvider = catalog[GITHUB_COPILOT_PROVIDER_ID];

	const allModels = {
		...modelsDev,
		[OPENAI_CODEX_PROVIDER_ID]: customCodexModels,
		...(copilotProvider ? { [GITHUB_COPILOT_PROVIDER_ID]: githubCopilotBuiltInModels(copilotProvider) } : {}),
	};
	await Filesystem.writeJsonAtomic(path, allModels);
	return path;
}

//
// CLI entry
export const ModelgenCommand: CommandModule<object, { path?: string | undefined }> = {
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
	applyModelMetadata(info);
	return info;
}
