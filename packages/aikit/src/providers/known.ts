import Type, { type Static } from "typebox";

// TODO do we need to migrate this to protocol.ts?
export const KnownProtocolEnum = {
	anthropicMessages: "anthropic-messages",
	openaiCompletions: "openai-completions",
	openaiResponses: "openai-responses",
} as const;
export const KnownProtocolSchema = Type.Union([
	Type.Literal(KnownProtocolEnum.anthropicMessages),
	Type.Literal(KnownProtocolEnum.openaiCompletions),
	Type.Literal(KnownProtocolEnum.openaiResponses),
]);
export type KnownProtocol = Static<typeof KnownProtocolSchema>;

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
