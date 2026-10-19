/*
 * @file OpenRouter's own model listing, read two ways.
 *
 * The generator builds the `openrouter` catalog from the public `GET /models` (pi): it carries
 * the reasoning efforts each model accepts, which models.dev only covers for some. At runtime
 * `GET /models/user` narrows that catalog to what one key may use, with that key's limits and
 * prices. Both go through the same field readers.
 */
import * as Model from "./model.ts";

export const PROVIDER_ID = "openrouter";
export const BASE_URL = "https://openrouter.ai/api/v1";
const NPM = "@openrouter/ai-sdk-provider";
const USER_MODELS_TIMEOUT_MS = 15_000;

/** OpenRouter's per-token prices, as decimal strings. */
interface Pricing {
	prompt?: string;
	completion?: string;
	input_cache_read?: string;
	input_cache_write?: string;
	/** Conditional prices: `min_prompt_tokens` selects prompt-length pricing, `utc_*` time-of-day pricing. */
	overrides?: Array<{
		min_prompt_tokens?: number;
		utc_start?: number;
		utc_end?: number;
		utc_days?: string[];
		prompt?: string;
		completion?: string;
		input_cache_read?: string;
		input_cache_write?: string;
	}>;
}

/** The fields read from an entry of `GET /models` and `GET /models/user`. */
export interface Entry {
	id: string;
	name?: string;
	context_length?: number | null;
	top_provider?: { context_length?: number | null; max_completion_tokens?: number | null };
	pricing?: Pricing;
	supported_parameters?: string[];
	architecture?: { input_modalities?: string[] };
	reasoning?: {
		mandatory?: boolean;
		supported_efforts?: string[];
	} | null;
}

/**
 * $/token to $/1M tokens. Missing, invalid and negative prices use the fallback: OpenRouter
 * reports -1 for router models such as `openrouter/auto`, whose price depends on the model it picks.
 */
function perMillion(value: string | undefined, fallback: number): number {
	const perToken = Number.parseFloat(value ?? "");
	return perToken >= 0 ? Number((perToken * 1_000_000).toFixed(6)) : fallback;
}

/**
 * Prompt-length overrides become request-wide tiers; a rate a tier does not list keeps the base
 * price. Time-of-day overrides are skipped: the cost model cannot express them.
 */
export function cost(pricing: Pricing | undefined): Model.Info["cost"] {
	const base = {
		input: perMillion(pricing?.prompt, 0),
		output: perMillion(pricing?.completion, 0),
		cacheRead: perMillion(pricing?.input_cache_read, 0),
		cacheWrite: perMillion(pricing?.input_cache_write, 0),
	};
	const tiers = (pricing?.overrides ?? []).flatMap((override) => {
		if (
			override.min_prompt_tokens === undefined ||
			override.utc_start !== undefined ||
			override.utc_end !== undefined ||
			override.utc_days !== undefined
		) {
			return [];
		}
		return [
			{
				inputTokensAbove: override.min_prompt_tokens,
				input: perMillion(override.prompt, base.input),
				output: perMillion(override.completion, base.output),
				cacheRead: perMillion(override.input_cache_read, base.cacheRead),
				cacheWrite: perMillion(override.input_cache_write, base.cacheWrite),
			},
		];
	});
	return tiers.length > 0 ? { ...base, tiers } : base;
}

/**
 * `supported_efforts` uses models.dev's effort vocabulary. Off maps to `none` unless reasoning is
 * mandatory; a mandatory model without listed efforts can only refuse off.
 */
export function thinkingLevels(reasoning: Entry["reasoning"]): Model.ThinkingLevelMap | undefined {
	if (!reasoning) return undefined;
	const map = Model.effortThinkingLevels(reasoning.supported_efforts ?? []);
	if (!map) return reasoning.mandatory === true ? { off: null } : undefined;
	return { ...map, off: reasoning.mandatory === true ? null : "none" };
}

/**
 * The catalog entry for one listed model, or undefined for one an agent cannot use: no tool
 * calling, or a `:batch` variant, whose asynchronous pricing an interactive turn never gets.
 */
export function toModel(entry: Entry): Model.Info | undefined {
	if (!entry.supported_parameters?.includes("tools") || entry.id.endsWith(":batch")) return undefined;
	const thinkingLevelMap = thinkingLevels(entry.reasoning);
	return {
		id: entry.id,
		name: entry.name ?? entry.id,
		provider: { id: PROVIDER_ID, name: "OpenRouter", source: "api", env: ["OPENROUTER_API_KEY"] },
		baseUrl: BASE_URL,
		reasoning: entry.supported_parameters.includes("reasoning"),
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		input: Model.normalizeInput(entry.architecture?.input_modalities),
		cost: cost(entry.pricing),
		// `||`: OpenRouter reports a missing limit as absent, null or 0.
		contextWindow: entry.top_provider?.context_length || entry.context_length || 4096,
		maxTokens: entry.top_provider?.max_completion_tokens || 4096,
		npm: NPM,
		api: { id: entry.id, url: BASE_URL, method: Model.APIMethodEnum.languageModel },
		providerOptionsKey: PROVIDER_ID,
		protocol: Model.KnownProviderEnum.openrouter,
	};
}

function entries(body: unknown): Entry[] {
	if (typeof body !== "object" || body === null || !("data" in body) || !Array.isArray(body.data)) {
		throw new Error("invalid OpenRouter model list");
	}
	return body.data.filter(
		(entry: unknown): entry is Entry =>
			typeof entry === "object" && entry !== null && "id" in entry && typeof entry.id === "string",
	);
}

/** The public `GET /models`, built into catalog entries keyed by id. */
export function catalog(body: unknown): Record<string, Model.Info> {
	const models: Record<string, Model.Info> = {};
	for (const entry of entries(body)) {
		const model = toModel(entry);
		if (model) models[model.id] = model;
	}
	return models;
}

/**
 * Restrict OpenRouter models to those `key` may use, with the key's limits and prices from
 * `GET /models/user` (pi). A missing limit keeps the catalog value. When the endpoint rejects the
 * key (401/403) or does not exist (404), the models come back unchanged.
 */
export async function personalize(
	models: Record<string, Model.Info>,
	key: string,
	options: { readonly baseUrl?: string; readonly signal?: AbortSignal } = {},
): Promise<Record<string, Model.Info>> {
	const signal = AbortSignal.timeout(USER_MODELS_TIMEOUT_MS);
	const response = await fetch(`${(options.baseUrl ?? BASE_URL).replace(/\/+$/, "")}/models/user`, {
		headers: { accept: "application/json", authorization: `Bearer ${key}` },
		signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal,
	});
	if (response.status === 401 || response.status === 403 || response.status === 404) return models;
	if (!response.ok) throw new Error(`OpenRouter model list request failed: ${response.status}`);
	const allowed = new Map(entries(await response.json()).map((entry) => [entry.id, entry]));

	const personal: Record<string, Model.Info> = {};
	for (const [id, model] of Object.entries(models)) {
		const entry = allowed.get(id);
		if (!entry) continue;
		personal[id] = {
			...model,
			contextWindow: entry.top_provider?.context_length || entry.context_length || model.contextWindow,
			maxTokens: entry.top_provider?.max_completion_tokens || model.maxTokens,
			cost: entry.pricing ? cost(entry.pricing) : model.cost,
		};
	}
	return personal;
}

export * as OpenRouter from "./openrouter.ts";
