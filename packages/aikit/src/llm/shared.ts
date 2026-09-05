import { Type, type Static } from "typebox";
import type * as Message from "../message/message.ts";
import * as Model from "../model/model.ts";
import { estimateContextTokens } from "../utils/estimate.ts";

export const CacheRetention = Type.Union([Type.Literal("none"), Type.Literal("short"), Type.Literal("long")]);
export type CacheRetention = Static<typeof CacheRetention>;

export const GenerationOptions = Type.Object({
	maxTokens: Type.Optional(Type.Number()),
	temperature: Type.Optional(Type.Number()),
	cacheRetention: Type.Optional(CacheRetention),
});

export const HelperOptions = Type.Object({
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	sessionId: Type.Optional(Type.String()),
	apiKey: Type.Optional(Type.String()),
	timeoutMs: Type.Optional(Type.Number()),
	maxRetries: Type.Optional(Type.Number()),
	signal: Type.Optional(Type.Unsafe<AbortSignal>({})),
	onPayload: Type.Optional(
		Type.Unsafe<(payload: unknown, model: Model.TModel<Model.KnownProviderEnum>) => Promise<unknown>>({}),
	),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export const ThinkingBudgets = Model.ThinkingBudgets;
export type ThinkingBudgets = Model.ThinkingBudgets;

export const SharedOptions = Type.Evaluate(Type.Intersect([GenerationOptions, HelperOptions]));
export type SharedOptions = Static<typeof SharedOptions>;

/** Headroom left for the prompt when sizing a response against the context window. */
const CONTEXT_SAFETY_TOKENS = 4096;
const MIN_MAX_TOKENS = 1;

/**
 * The model's own ceiling, unless the caller named a smaller one.
 *
 * No heuristic cap here: a catalog whose `maxTokens` spans the whole context
 * window is handled by {@link clampMaxTokensToContext}, which knows what the
 * prompt actually costs and does not have to guess.
 */
export function applyDefaultMaxTokens<TOptions extends SharedOptions = SharedOptions>(
	model: Model.TModel<Model.KnownProviderEnum>,
	options?: TOptions,
): TOptions & Pick<SharedOptions, "maxTokens"> {
	return {
		...options,
		maxTokens: options?.maxTokens ?? (model.maxTokens > 0 ? model.maxTokens : undefined),
	} as TOptions & Pick<SharedOptions, "maxTokens">;
}

/**
 * Shrink a response ceiling to what is left of the context window.
 *
 * Without this a long session asks for an answer that cannot fit and takes a
 * provider overflow error instead of a shorter answer.
 */
export function clampMaxTokensToContext(
	model: Model.TModel<Model.KnownProviderEnum>,
	context: Message.Context,
	maxTokens: number,
): number {
	if (model.contextWindow <= 0) return Math.max(MIN_MAX_TOKENS, maxTokens);
	const available = model.contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS;
	return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, available));
}

/** Tokens always left for the answer when a thinking budget shares the response ceiling. */
export const MIN_ANSWER_TOKENS = 1024;

/**
 * Default thinking budget per level, in tokens.
 *
 * Absolute rather than a fraction of `model.maxTokens`: a fraction turns one
 * "medium" setting into wildly different budgets across models, and a budget is
 * a property of how hard the task is, not of how large the model's ceiling is.
 */
export const DEFAULT_THINKING_BUDGETS = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
} as const;

type BaseThinkingLevel = keyof typeof DEFAULT_THINKING_BUDGETS;

/** `xhigh` and `max` fall back to `high`'s budget unless one is configured for them. */
function baseThinkingLevel(level: Model.ActiveThinkingLevel): BaseThinkingLevel {
	return level === "xhigh" || level === "max" ? "high" : level;
}

export function thinkingBudgetForLevel(level: Model.ActiveThinkingLevel, budgets?: ThinkingBudgets): number {
	const base = baseThinkingLevel(level);
	return budgets?.[level] ?? budgets?.[base] ?? DEFAULT_THINKING_BUDGETS[base];
}

/** Cap a thinking budget so at least {@link MIN_ANSWER_TOKENS} remain under a shared response ceiling. */
export function clampThinkingBudgetToAnswerRoom(thinkingBudget: number, ceiling: number): number {
	return Math.min(thinkingBudget, Math.max(0, ceiling - MIN_ANSWER_TOKENS));
}

/**
 * Fit a thinking budget and an answer inside one response ceiling.
 *
 * The caller's `maxTokens` is the room they want for the *answer*, so thinking is
 * added on top and the total is clamped to the model's ceiling. When even that
 * does not fit, the budget gives way -- never the answer.
 */
export function adjustMaxTokensForThinking(
	// Undefined means no explicit caller cap. Use the model cap and fit thinking inside it.
	baseMaxTokens: number | undefined,
	modelMaxTokens: number,
	level: Model.ActiveThinkingLevel,
	budgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
	let thinkingBudget = thinkingBudgetForLevel(level, budgets);
	const maxTokens =
		baseMaxTokens === undefined ? modelMaxTokens : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

	if (maxTokens <= thinkingBudget) {
		thinkingBudget = clampThinkingBudgetToAnswerRoom(thinkingBudget, maxTokens);
	}

	return { maxTokens, thinkingBudget };
}
