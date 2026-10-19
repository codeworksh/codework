import { resolve } from "node:path";
import { mapValues, pick, pickBy, pipe } from "remeda";
import type { CommandModule } from "yargs";
import { DEFAULT_AI_SDK_FALLBACK, isAISDKPackage, protocolForPackage } from "../llm/registry.ts";
import * as ModelCatalog from "../model/catalog.ts";
import * as Model from "../model/model.ts";
import { OpenRouter } from "../model/openrouter.ts";
import { GITHUB_COPILOT_STATIC_HEADERS } from "../providers/github-copilot/copilot-headers.ts";
import * as Filesystem from "../utils/filesystem.ts";

const DEFAULT_PROVIDER_BASE_URLS: Partial<Record<Model.KnownProviderEnum, string>> = {
	[Model.KnownProviderEnum.anthropic]: "https://api.anthropic.com/v1",
	[Model.KnownProviderEnum.openai]: "https://api.openai.com/v1",
	[Model.KnownProviderEnum.openrouter]: OpenRouter.BASE_URL,
	[Model.KnownProviderEnum.xai]: "https://api.x.ai/v1",
};

interface ModelsDevCost {
	input?: number;
	output?: number;
	cache_read?: number;
	cache_write?: number;
}

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
	cost?: ModelsDevCost & {
		tiers?: Array<ModelsDevCost & { tier?: { type?: string; size?: number } }>;
	};
	reasoning_options?: Array<{
		type?: string;
		values?: Array<string | null>;
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
	/** Request variants such as OpenAI's `service_tier: "priority"`, each with its own price. */
	experimental?: {
		modes?: Record<string, { cost?: ModelsDevCost; provider?: { body?: Record<string, unknown> } }>;
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

/** The catalog's sources, fetched: models.dev, and OpenRouter's own listing when it answered. */
export interface Sources {
	readonly modelsDev: ModelsDevCatalog;
	readonly openRouter?: unknown;
}

/** Providers bundled with aikit as the baseline catalog, read until a generated one exists. */
export const BASELINE_PROVIDERS = ["anthropic", "openai", OpenRouter.PROVIDER_ID] as const;

function modelsDevURL(): string {
	return process.env.CODEWORK_MODELS_DEV_URL || "https://models.dev";
}

function modelsDevPath(): string | undefined {
	return process.env.CODEWORK_MODELS_DEV_FILE;
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

/** OpenRouter's public listing, or undefined when it cannot be had: models.dev's copy stands in. */
async function pullOpenRouterData(): Promise<unknown> {
	try {
		const response = await fetch(`${OpenRouter.BASE_URL}/models`, { signal: AbortSignal.timeout(30_000) });
		return response.ok ? await response.json() : undefined;
	} catch {
		return undefined;
	}
}

function toModelValue(providerId: string, provider: ModelsDevProvider, model: ModelsDevModel): Model.Info | undefined {
	return applyModification(providerId, provider, model);
}

// models.dev lists this alias, but OpenAI's APIs do not accept it (pi).
const MODELS_DEV_UNSUPPORTED_MODEL_IDS = new Set(["openai/gpt-5.6"]);

function usable(providerId: string, provider: ModelsDevProvider, model: ModelsDevModel): boolean {
	return (
		Boolean(model.tool_call) &&
		!MODELS_DEV_UNSUPPORTED_MODEL_IDS.has(`${providerId}/${model.id}`) &&
		// If `resolveModelNpm` fallbacks to `@ai-sdk/openai-compatible`
		// isAISDKPakage will be truthy, modify resolveModelNpm for custom logic if needed.
		// Keep `isAISDKPackage` as readonly for supported implemenatations key check
		isAISDKPackage(resolveModelNpm(provider, model))
	);
}

function loadBuiltInFromModelsDev(catalog: ModelsDevCatalog) {
	return pipe(
		catalog,
		pickBy((provider, providerId) =>
			Object.values(provider.models).some((model) => usable(providerId, provider, model)),
		),
		mapValues((provider, providerId) =>
			pipe(
				provider.models,
				pickBy((model) => usable(providerId, provider, model)),
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

function roundCost(value: number): number {
	return Number(value.toFixed(6));
}

/** models.dev prices, with its context tiers; a rate a tier does not list keeps the base price (pi). */
function modelsDevCost(cost: ModelsDevModel["cost"]): Model.Info["cost"] {
	const base = {
		input: cost?.input ?? 0,
		output: cost?.output ?? 0,
		cacheRead: cost?.cache_read ?? 0,
		cacheWrite: cost?.cache_write ?? 0,
	};
	const tiers = cost?.tiers?.flatMap((tier) => {
		const context = tier.tier;
		if (context?.type !== "context" || context.size === undefined) return [];
		return [
			{
				inputTokensAbove: context.size,
				input: tier.input ?? base.input,
				output: tier.output ?? base.output,
				cacheRead: tier.cache_read ?? base.cacheRead,
				cacheWrite: tier.cache_write ?? base.cacheWrite,
			},
		];
	});
	return tiers && tiers.length > 0 ? { ...base, tiers } : base;
}

/** The efforts models.dev verified for a model, or undefined when it lists none. */
function modelsDevEfforts(model: ModelsDevModel | undefined): Array<string | null> | undefined {
	const efforts = model?.reasoning_options?.flatMap((option) =>
		option.type === "effort" && Array.isArray(option.values) ? option.values : [],
	);
	return efforts && efforts.length > 0 ? efforts : undefined;
}

function mergeThinkingLevelMap(model: Model.Info, map: ThinkingLevelMap): void {
	model.thinkingLevelMap = { ...model.thinkingLevelMap, ...map };
}

function mergeCompat(model: Model.Info, compat: Model.Compatibility): void {
	model.compat = { ...model.compat, ...compat };
}

/** Merge the level map models.dev's verified efforts give, when it lists any. */
function applyEffortThinkingLevels(model: Model.Info, source: ModelsDevModel | undefined): void {
	const efforts = modelsDevEfforts(source);
	const map = efforts ? Model.effortThinkingLevels(efforts) : undefined;
	if (map) mergeThinkingLevelMap(model, map);
}

//
// OpenAI (pi).
const OPENAI_LONG_CONTEXT_INPUT_THRESHOLD = 272_000;
const OPENAI_MAX_TOKENS = 128_000;

const OPENAI_RESPONSES_NONE_REASONING_MODELS = new Set([
	"gpt-5.1",
	"gpt-5.2",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-6-luna",
	"gpt-6-sol",
]);

// Every GPT-6 model takes low through max and rejects "minimal"; Astra and 6.1 Sol also reject "none".
const OPENAI_GPT6_MODELS = new Set(["gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol"]);
const OPENAI_GPT6_NO_NONE_MODELS = new Set(["gpt-6-astra", "gpt-6.1-sol"]);

// Checked live against the Responses and Codex APIs: these families reject
// reasoning.effort "minimal".
const OPENAI_NO_MINIMAL_REASONING = /gpt-5\.[456]|gpt-6/;

// Direct requests stay in the short-context price tier by default; the long-context price stays in
// `cost.tiers` for a settings entry that opts into the full window.
const OPENAI_SHORT_CONTEXT_CAPPED_MODELS = new Set([
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-6-astra",
	"gpt-6-luna",
	"gpt-6-sol",
	"gpt-6.1-sol",
]);

// Models billed at 2x input / 1.5x output above the threshold, when models.dev has no tier for them.
const OPENAI_LONG_CONTEXT_PRICING_MODELS = new Set([
	...OPENAI_SHORT_CONTEXT_CAPPED_MODELS,
	"gpt-5.4-pro",
	"gpt-5.5-pro",
]);

function isOpenAiResponses(model: Model.Info): boolean {
	return model.protocol === Model.KnownProviderEnum.openai || model.protocol === Model.KnownProviderEnum.openaiCodex;
}

function isOpenAiDirect(model: Model.Info): boolean {
	return model.protocol === Model.KnownProviderEnum.openai && model.provider.id === "openai";
}

function supportsOpenAiXhigh(model: Model.Info): boolean {
	return /gpt-5\.[2-6]|gpt-6/.test(model.id);
}

function supportsOpenAiMax(model: Model.Info): boolean {
	return isOpenAiResponses(model) && /gpt-5\.6|gpt-6/.test(model.id);
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

/**
 * Price multipliers per service tier: models.dev's modes that set `service_tier` (fast is
 * `priority`), over OpenAI's flex 0.5x / priority 2x list defaults.
 */
function serviceTierMultipliers(model: Model.Info, source: ModelsDevModel | undefined): Record<string, number> {
	const multipliers: Record<string, number> = { flex: 0.5, priority: 2 };
	for (const mode of Object.values(source?.experimental?.modes ?? {})) {
		const tier = mode.provider?.body?.service_tier;
		const input = mode.cost?.input;
		if (typeof tier !== "string" || input === undefined || model.cost.input <= 0) continue;
		multipliers[tier] = roundCost(input / model.cost.input);
	}
	return multipliers;
}

function applyOpenAiMetadata(model: Model.Info, source: ModelsDevModel | undefined): void {
	const id = model.id;
	if (isOpenAiDirect(model)) {
		if (OPENAI_SHORT_CONTEXT_CAPPED_MODELS.has(id)) {
			model.contextWindow = OPENAI_LONG_CONTEXT_INPUT_THRESHOLD;
			model.maxTokens = OPENAI_MAX_TOKENS;
		}
		if (OPENAI_LONG_CONTEXT_PRICING_MODELS.has(id) && !model.cost.tiers) {
			model.cost = withOpenAiLongContextPricing(model.cost);
		}
		// models.dev reports the input sub-limit as gpt-5-pro's output.
		if (id === "gpt-5-pro") model.maxTokens = OPENAI_MAX_TOKENS;
	}
	model.cost.serviceTierMultipliers = serviceTierMultipliers(model, source);

	// models.dev's verified efforts first, then the corrections checked against the API.
	applyEffortThinkingLevels(model, source);
	if (model.protocol === Model.KnownProviderEnum.openai && id.startsWith("gpt-5")) {
		mergeThinkingLevelMap(model, { off: null });
	}
	if (OPENAI_GPT6_MODELS.has(id)) {
		mergeThinkingLevelMap(model, {
			off: OPENAI_GPT6_NO_NONE_MODELS.has(id) ? null : "none",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	}
	if (isOpenAiDirect(model) && OPENAI_RESPONSES_NONE_REASONING_MODELS.has(id)) {
		mergeThinkingLevelMap(model, { off: "none" });
	}
	if (supportsOpenAiMax(model)) mergeThinkingLevelMap(model, { max: "max" });
	if (OPENAI_NO_MINIMAL_REASONING.test(id)) mergeThinkingLevelMap(model, { minimal: null });
	if (id.endsWith("gpt-5.5-pro")) mergeThinkingLevelMap(model, { off: null, minimal: null, low: null });
}

//
// Anthropic (pi).
function isAnthropicMessages(model: Model.Info): boolean {
	return (
		model.protocol === Model.KnownProviderEnum.anthropic ||
		model.protocol === Model.KnownProviderEnum.googleVertexAnthropic
	);
}

// The Messages API rejects `temperature` on these.
const ANTHROPIC_NO_TEMPERATURE = /opus-4[-.][78]|opus-5|(sonnet|haiku)-5[-.]5/;

// Checked live against the Messages API: effort levels each adaptive family
// accepts, the 5.5 and Fable models that reject `thinking: {type: "disabled"}`, and
// Sonnet 4.5's window, which is 1M only behind a beta header.
function applyAnthropicMetadata(model: Model.Info): void {
	const id = model.id;
	if (/sonnet-4[-.]5/.test(id)) model.contextWindow = 200_000;
	// Not models.dev's efforts: Anthropic disables thinking by a toggle, not an effort of "none" (pi).
	if (Model.isAnthropicAdaptiveThinkingModel(id)) mergeCompat(model, { forceAdaptiveThinking: true });
	if (/(opus|sonnet)-4[-.]6/.test(id)) {
		mergeThinkingLevelMap(model, { max: "max" });
	}
	if (/opus-4[-.][78]|(opus|sonnet|fable|haiku)-5/.test(id)) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh", max: "max" });
	}
	if (/(opus|sonnet|haiku)-5[-.]5/.test(id)) {
		// Haiku 5.5 accepts disabled thinking; Opus 5.5 and Sonnet 5.5 reject it.
		mergeThinkingLevelMap(model, {
			...(id.includes("haiku") ? {} : { off: null }),
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	}
	if (/fable-5/.test(id)) {
		mergeThinkingLevelMap(model, { off: null });
	}
	if (ANTHROPIC_NO_TEMPERATURE.test(id)) mergeCompat(model, { supportsTemperature: false });
}

//
// Google.
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

function applyModelMetadata(model: Model.Info, source: ModelsDevModel | undefined): void {
	const isGoogle =
		model.protocol === Model.KnownProviderEnum.google || model.protocol === Model.KnownProviderEnum.googleVertex;
	if (isGoogle) {
		applyGoogleThinkingMetadata(model);
		if (/gemini-3(?:\.\d+)?-pro|gemini-3\.[78]-flash/.test(model.id.toLowerCase())) {
			// These models cannot disable thinking or accept minimal. Expose supported
			// levels to callers and let the shared clamp promote minimal to low.
			mergeThinkingLevelMap(model, { off: "low", minimal: null });
		}
	}
	// Proxied Claude ids (Copilot) keep the effort aliases the Messages API takes.
	if (model.id.includes("opus-4-6") || model.id.includes("opus-4.6")) {
		mergeThinkingLevelMap(model, { xhigh: "max" });
	}
	if (model.id.includes("opus-4-7") || model.id.includes("opus-4.7")) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	}
	if (isOpenAiResponses(model)) applyOpenAiMetadata(model, source);
	// By id, for every provider serving these GPT models (pi).
	if (supportsOpenAiXhigh(model)) mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	if (isAnthropicMessages(model)) applyAnthropicMetadata(model);
}

//
// OpenAI Codex (ChatGPT OAuth) models.
// Built from the OpenAI entries: Codex serves the same models at the same list prices, so only
// which models it offers, its window and its tool support are its own. Context windows are the
// observed server limits (400s above them), not marketing numbers.
const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const OPENAI_CODEX_NPM = "@codeworksh/ai-sdk-openai-codex";
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_CODEX_CONTEXT = 272_000;
const OPENAI_CODEX_MODELS: ReadonlyArray<{ readonly id: string; readonly contextWindow?: number }> = [
	{ id: "gpt-5.3-codex-spark", contextWindow: 128_000 },
	{ id: "gpt-5.5" },
	{ id: "gpt-5.6-luna" },
	{ id: "gpt-5.6-sol" },
	{ id: "gpt-5.6-terra" },
	{ id: "gpt-6-astra" },
	{ id: "gpt-6-luna" },
	{ id: "gpt-6-sol" },
	{ id: "gpt-6.1-sol", contextWindow: 500_000 },
];
const OPENAI_CODEX_ADDITIONAL_TOOLS_MODEL_IDS = new Set([
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-6-astra",
	"gpt-6-luna",
	"gpt-6-sol",
	"gpt-6.1-sol",
]);
const OPENAI_CODEX_TOOL_SEARCH_MODEL_IDS = new Set(["gpt-5.5", ...OPENAI_CODEX_ADDITIONAL_TOOLS_MODEL_IDS]);
// Checked live: the Codex backend accepts reasoning.effort "none" for these.
const OPENAI_CODEX_NONE_REASONING_MODEL_IDS = new Set(["gpt-5.5", "gpt-5.6-luna", "gpt-6-luna", "gpt-6-sol"]);

/** The Codex models, from the generated `openai` entries; one models.dev does not list is skipped. */
export function openAICodexBuiltInModels(openai: Record<string, Model.Info>): Record<string, Model.Info> {
	const models: Record<string, Model.Info> = {};
	for (const seed of OPENAI_CODEX_MODELS) {
		const base = openai[seed.id];
		if (!base) continue;
		const info: Model.Info = {
			...base,
			provider: {
				id: OPENAI_CODEX_PROVIDER_ID,
				name: "OpenAI Codex (ChatGPT)",
				source: "custom",
				env: ["OPENAI_CODEX_API_KEY"],
			},
			baseUrl: OPENAI_CODEX_BASE_URL,
			reasoning: true,
			thinkingLevelMap: {
				...base.thinkingLevelMap,
				// Codex models reason unless verified to accept "none".
				off: OPENAI_CODEX_NONE_REASONING_MODEL_IDS.has(seed.id) ? "none" : null,
				// The backend takes "low" where the API would reject "minimal" (pi).
				...(supportsOpenAiXhigh(base) ? { minimal: "low" } : {}),
			},
			contextWindow: seed.contextWindow ?? OPENAI_CODEX_CONTEXT,
			maxTokens: OPENAI_MAX_TOKENS,
			npm: OPENAI_CODEX_NPM,
			api: {
				id: seed.id,
				url: OPENAI_CODEX_BASE_URL,
				method: Model.APIMethodEnum.responses,
			},
			providerOptionsKey: OPENAI_CODEX_PROVIDER_ID,
			compat: {
				supportsOpenAIGrammarTools: true,
				...(OPENAI_CODEX_TOOL_SEARCH_MODEL_IDS.has(seed.id) ? { supportsToolSearch: true } : {}),
				...(OPENAI_CODEX_ADDITIONAL_TOOLS_MODEL_IDS.has(seed.id) ? { supportsAdditionalTools: true } : {}),
			},
			protocol: Model.KnownProviderEnum.openaiCodex,
		};
		delete info.headers;
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

/**
 * Derive the level map from models.dev `reasoning_options`: a level maps to
 * itself only when the endpoint actually advertises it. `minimal` degrades to
 * `low` — the lowest effort every reasoning model accepts.
 */
function githubCopilotThinkingLevels(model: ModelsDevModel, method: Model.APIMethodEnum): ThinkingLevelMap | undefined {
	const listed = modelsDevEfforts(model);
	const efforts = listed ? new Set(listed) : undefined;
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

/** OpenRouter's listing as catalog entries, or undefined when it is missing or unreadable. */
function openRouterModels(listing: unknown): Record<string, Model.Info> | undefined {
	if (listing === undefined) return undefined;
	try {
		const models = OpenRouter.catalog(listing);
		return Object.keys(models).length > 0 ? models : undefined;
	} catch {
		return undefined;
	}
}

/** Object keys in order at every level, so identical content serializes to identical bytes. */
function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, entry]) => [key, sortKeys(entry)]),
	);
}

/**
 * The catalog from fetched sources, keys sorted so identical content serializes to identical
 * bytes. OpenRouter's own listing replaces models.dev's copy of it.
 */
export function buildCatalog(sources: Sources): BuiltInModels {
	const modelsDev = loadBuiltInFromModelsDev(sources.modelsDev);
	const openrouter = openRouterModels(sources.openRouter);
	const copilotProvider = sources.modelsDev[GITHUB_COPILOT_PROVIDER_ID];
	return sortKeys({
		...modelsDev,
		...(openrouter ? { [OpenRouter.PROVIDER_ID]: openrouter } : {}),
		[OPENAI_CODEX_PROVIDER_ID]: openAICodexBuiltInModels(modelsDev.openai ?? {}),
		...(copilotProvider ? { [GITHUB_COPILOT_PROVIDER_ID]: githubCopilotBuiltInModels(copilotProvider) } : {}),
	}) as BuiltInModels;
}

export interface GenerateOptions {
	/** Output file; defaults to `CODEWORK_MODELS_FILE` or `./models.gen.json`. */
	readonly path?: string | undefined;
	/** Keep only {@link BASELINE_PROVIDERS}, for the catalog bundled with aikit. */
	readonly baseline?: boolean | undefined;
	/** Narrow OpenRouter to the models this key may use, with its limits and prices. */
	readonly openRouterKey?: string | undefined;
}

export async function generateModels(args: GenerateOptions = {}): Promise<string> {
	const path = resolve(args.path ?? ModelCatalog.path());
	const [modelsDev, openRouter] = await Promise.all([pullModelsDevData(), pullOpenRouterData()]);
	let catalog = buildCatalog({ modelsDev, openRouter });
	if (args.baseline) catalog = pick(catalog, BASELINE_PROVIDERS);

	const openrouter = catalog[OpenRouter.PROVIDER_ID];
	if (args.openRouterKey && openrouter) {
		// The shared listing still beats none when OpenRouter cannot say what the key may use.
		catalog[OpenRouter.PROVIDER_ID] = await OpenRouter.personalize(openrouter, args.openRouterKey).catch(
			() => openrouter,
		);
	}
	await Filesystem.writeJsonAtomic(path, catalog);
	return path;
}

//
// CLI entry
export const ModelgenCommand: CommandModule<object, { path?: string | undefined; baseline?: boolean | undefined }> = {
	command: "modelgen [path]",
	describe: "generate models.gen.json",
	builder: (yargs) =>
		yargs
			.positional("path", {
				type: "string",
				describe: "output path (defaults to CODEWORK_MODELS_FILE or ./models.gen.json)",
			})
			.option("baseline", {
				type: "boolean",
				describe: `keep only the bundled baseline providers (${BASELINE_PROVIDERS.join(", ")})`,
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
		cost: modelsDevCost(model.cost),
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
	applyModelMetadata(info, model);
	return info;
}
