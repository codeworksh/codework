import { type Static, Type } from "@sinclair/typebox";

export namespace Provider {
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
	export const KnownProviderSchema = Type.Union([
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
	export type KnownProvider = Static<typeof KnownProviderSchema>;

	export const Info = Type.Object({
		id: KnownProviderSchema,
		name: Type.String(),
		env: Type.Array(Type.String()),
		key: Type.Optional(Type.String()),
		options: Type.Optional(Type.Record(Type.String(), Type.Any())),
	});
	export type Info = Static<typeof Info>;

	export const ReasoningEffortMapSchema = Type.Object({
		minimal: Type.Optional(Type.String()),
		low: Type.Optional(Type.String()),
		medium: Type.Optional(Type.String()),
		high: Type.Optional(Type.String()),
		xhigh: Type.Optional(Type.String()),
	});
	export type ReasoningEffortMap = Static<typeof ReasoningEffortMapSchema>;
	export type StrictReasoningEffortMap = {
		[K in keyof ReasoningEffortMap]-?: NonNullable<ReasoningEffortMap[K]>;
	};

	export const OpenRouterRoutingSchema = Type.Object({
		only: Type.Optional(Type.Array(Type.String())),
		order: Type.Optional(Type.Array(Type.String())),
	});
	export type OpenRouterRouting = Static<typeof OpenRouterRoutingSchema>;

	export const VercelGatewayRoutingSchema = Type.Object({
		only: Type.Optional(Type.Array(Type.String())),
		order: Type.Optional(Type.Array(Type.String())),
	});
	export type VercelGatewayRouting = Static<typeof VercelGatewayRoutingSchema>;
}
