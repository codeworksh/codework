import { Type, type Static } from "typebox";
import type * as Message from "../message/message.ts";
import * as Model from "../model/model.ts";
import { estimateContextTokens } from "../utils/estimate.ts";

const CacheRetention = Type.Union([Type.Literal("none"), Type.Literal("short"), Type.Literal("long")]);
export type CacheRetention = Static<typeof CacheRetention>;

const GenerationOptions = Type.Object({
	maxTokens: Type.Optional(Type.Number()),
	temperature: Type.Optional(Type.Number()),
	cacheRetention: Type.Optional(CacheRetention),
});

const HelperOptions = Type.Object({
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	sessionId: Type.Optional(Type.String()),
	apiKey: Type.Optional(Type.String()),
	timeoutMs: Type.Optional(Type.Number()),
	/** Abort a stream that goes this long without a chunk, so a dead connection fails instead of waiting out `timeoutMs`. */
	idleTimeoutMs: Type.Optional(Type.Number()),
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
// OpenRouter counts the input with its own tokenizer and rejects input + max_tokens above the
// window before routing. It counted prose up to 12% above the provider's count.
const CONTEXT_SAFETY_RATIO = 0.15;
// The 15% margin is kept only while it leaves at least this much output. Otherwise (a nearly full
// large window, or any small window such as a 32k local model) only the fixed margin is kept, and
// output is capped at this size so an OpenRouter overcount still fits for a while before compaction.
const MIN_OUTPUT_WITH_RATIO_MARGIN = 32768;
// The smallest ceiling OpenAI accepts (`max_output_tokens` >= 16). Below it an
// overflowing prompt fails as an invalid parameter instead of a context overflow.
const MIN_MAX_TOKENS = 16;

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
 * provider overflow error instead of a shorter answer. The margin leaves room
 * for the input being counted higher than estimated.
 */
export function clampMaxTokensToContext(
	model: Model.TModel<Model.KnownProviderEnum>,
	context: Message.Context,
	maxTokens: number,
): number {
	if (model.contextWindow <= 0) return Math.max(MIN_MAX_TOKENS, maxTokens);
	const input = estimateContextTokens(context).tokens;
	const margin = Math.max(CONTEXT_SAFETY_TOKENS, Math.ceil(input * CONTEXT_SAFETY_RATIO));
	let room = model.contextWindow - input - margin;
	if (room < MIN_OUTPUT_WITH_RATIO_MARGIN) {
		room = Math.min(MIN_OUTPUT_WITH_RATIO_MARGIN, model.contextWindow - input - CONTEXT_SAFETY_TOKENS);
	}
	return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, room));
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
const DEFAULT_THINKING_BUDGETS = {
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
