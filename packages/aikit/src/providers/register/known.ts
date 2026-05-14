import Type, { type Static } from "typebox";

export namespace Known {
	export const ProtocolEnum = {
		anthropicMessages: "anthropic-messages",
		openaiCompletions: "openai-completions",
		openaiResponses: "openai-responses",
	} as const;
	export const ProtocolEnumSchema = Type.Union([
		Type.Literal(ProtocolEnum.anthropicMessages),
		Type.Literal(ProtocolEnum.openaiCompletions),
		Type.Literal(ProtocolEnum.openaiResponses),
	]);
	export type KnownProtocolEnum = Static<typeof ProtocolEnumSchema>;

	export const ProviderEnum = {
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
	export const ProviderEnumSchema = Type.Union([
		Type.Literal(ProviderEnum.anthropic),
		Type.Literal(ProviderEnum.openai),
		Type.Literal(ProviderEnum.githubCopilot),
		Type.Literal(ProviderEnum.openrouter),
		Type.Literal(ProviderEnum.groq),
		Type.Literal(ProviderEnum.xai),
		Type.Literal(ProviderEnum.cerebras),
		Type.Literal(ProviderEnum.zai),
		Type.Literal(ProviderEnum.opencode),
	]);
	export type KnownProviderEnum = Static<typeof ProviderEnumSchema>;
}
