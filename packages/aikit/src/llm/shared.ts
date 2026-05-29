import { Type, type Static } from "typebox";
import { type Model } from "../model/model";

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

export const ThinkingBudgets = Type.Object({
	minimal: Type.Optional(Type.Number()),
	low: Type.Optional(Type.Number()),
	medium: Type.Optional(Type.Number()),
	high: Type.Optional(Type.Number()),
	xhigh: Type.Optional(Type.Number()),
});
export type ThinkingBudgets = Static<typeof ThinkingBudgets>;

export const SharedOptions = Type.Evaluate(Type.Intersect([GenerationOptions, HelperOptions]));
export type SharedOptions = Static<typeof SharedOptions>;

const DEFAULT_MAX_OUTPUT_TOKENS = 32000;
const CONTEXT_WINDOW_OUTPUT_TOLERANCE = 1024;

export function applyDefaultMaxTokens<TOptions extends SharedOptions = SharedOptions>(
	model: Model.TModel<Model.KnownProviderEnum>,
	options?: TOptions,
): TOptions & Pick<SharedOptions, "maxTokens"> {
	const defaultMaxTokens =
		model.maxTokens > 0
			? model.maxTokens >= model.contextWindow - CONTEXT_WINDOW_OUTPUT_TOLERANCE
				? Math.min(model.maxTokens, DEFAULT_MAX_OUTPUT_TOKENS)
				: model.maxTokens
			: undefined;

	return {
		...options,
		maxTokens: options?.maxTokens ?? defaultMaxTokens,
	} as TOptions & Pick<SharedOptions, "maxTokens">;
}
