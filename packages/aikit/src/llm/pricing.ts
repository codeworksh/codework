/*
 * @file What a turn actually costs, as opposed to what it was asked to cost.
 *
 * Two pricing inputs are only knowable once the provider answers: the service
 * tier a request was *served* at, which may differ from the one requested, and
 * the retention split of Anthropic cache writes, which are billed at different
 * rates. Both arrive as provider metadata, so both are read here rather than in
 * the transport.
 */

import * as Model from "../model/model.ts";

/** Protocols that price a request by the OpenAI service tier it was served at. */
const SERVICE_TIER_KEYS = new Set(["openai", "openai-codex"]);

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function bag(value: unknown, key: string): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const nested = (value as Record<string, unknown>)[key];
	return typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>) : undefined;
}

/** The tier the request asked for, before the provider says which one it used. */
export function requestedServiceTier(
	model: Model.Info,
	options: { readonly factoryOptions?: Record<string, unknown> },
	providerOptions: Record<string, Record<string, unknown> | undefined>,
): string | undefined {
	const key = Model.optionsKey(model);
	if (!SERVICE_TIER_KEYS.has(key)) return undefined;
	return asString(
		providerOptions[key]?.serviceTier ?? options.factoryOptions?.serviceTier ?? model.options?.serviceTier,
	);
}

/**
 * The tier the response was actually served at, which is what gets billed.
 *
 * A `"default"` response to an explicit flex or priority request still bills at
 * the requested tier: the Codex backend reports the fallback it used, not the
 * rate it charged.
 */
export function servedServiceTier(
	model: Model.Info,
	requested: string | undefined,
	providerMetadata: unknown,
): string | undefined {
	const key = Model.optionsKey(model);
	if (!SERVICE_TIER_KEYS.has(key)) return undefined;
	const served = asString(bag(providerMetadata, key)?.serviceTier);
	if (key === "openai-codex" && served === "default" && (requested === "flex" || requested === "priority")) {
		return requested;
	}
	return served ?? requested;
}

export function serviceTierCostMultiplier(model: Model.Info, serviceTier: string | undefined): number {
	if (serviceTier === "flex") return 0.5;
	if (serviceTier === "priority") return model.id === "gpt-5.5" ? 2.5 : 2;
	return 1;
}

/**
 * Tokens Anthropic wrote with 1h retention, out of the total cache write.
 *
 * The AI SDK does not model the split, but it passes Anthropic's raw usage object
 * through untouched, so read it from there.
 */
export function cacheWrite1hTokens(providerMetadata: unknown): number | undefined {
	for (const key of ["anthropic", "google-vertex-anthropic"]) {
		const creation = bag(bag(bag(providerMetadata, key), "usage"), "cache_creation");
		const tokens = creation?.ephemeral_1h_input_tokens;
		if (typeof tokens === "number") return tokens;
	}
	return undefined;
}

export * as Pricing from "./pricing.ts";
