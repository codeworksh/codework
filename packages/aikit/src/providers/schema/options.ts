import { Type, type Static } from "typebox";
import { type Model } from "../../model/model";

export const TransportSchema = Type.Union([Type.Literal("sse"), Type.Literal("websocket"), Type.Literal("auto")]);
export type Transport = Static<typeof TransportSchema>;

export const CacheRetention = Type.Union([Type.Literal("none"), Type.Literal("short"), Type.Literal("long")]);
export type CacheRetention = Static<typeof CacheRetention>;

export const GenerationOptions = Type.Object({
	maxTokens: Type.Optional(Type.Number()),
	temperature: Type.Optional(Type.Number()),
	topP: Type.Optional(Type.Number()),
	topK: Type.Optional(Type.Number()),
	frequencyPenalty: Type.Optional(Type.Number()),
	presencePenalty: Type.Optional(Type.Number()),
	seed: Type.Optional(Type.Number()),
	stop: Type.Optional(Type.Array(Type.String())),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	// runtime options
	transport: Type.Optional(TransportSchema),
	sessionId: Type.Optional(Type.String()),
	retryDelayMaxMs: Type.Optional(Type.Number()),
	signal: Type.Optional(Type.Unsafe<AbortSignal>({})),
	onPayload: Type.Optional(Type.Unsafe<(payload: unknown, model: Model.TModel<Model.KnownProtocol>) => unknown>({})),
});

export const ThinkingLevelEnum = {
	off: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
} as const;
export const ThinkingLevelSchema = Type.Union([
	Type.Literal(ThinkingLevelEnum.off),
	Type.Literal(ThinkingLevelEnum.minimal),
	Type.Literal(ThinkingLevelEnum.low),
	Type.Literal(ThinkingLevelEnum.medium),
	Type.Literal(ThinkingLevelEnum.high),
	Type.Literal(ThinkingLevelEnum.xhigh),
]);
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

export const ThinkingBudgetsSchema = Type.Object({
	off: Type.Optional(Type.Number()),
	minimal: Type.Optional(Type.Number()),
	low: Type.Optional(Type.Number()),
	medium: Type.Optional(Type.Number()),
	high: Type.Optional(Type.Number()),
});
export type ThinkingBudgets = Static<typeof ThinkingBudgetsSchema>;
