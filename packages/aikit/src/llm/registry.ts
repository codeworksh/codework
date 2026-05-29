import type { LanguageModel } from "ai";
import { Model } from "../model/model";

export const DEFAULT_AI_SDK_PACKAGE = "@ai-sdk/openai-compatible";

export const AI_SDK_PACKAGE_TO_PROTOCOL = {
	"@ai-sdk/anthropic": Model.KnownProviderEnum.anthropic,
	"@ai-sdk/google": Model.KnownProviderEnum.google,
	"@ai-sdk/google-vertex": Model.KnownProviderEnum.googleVertex,
	"@ai-sdk/google-vertex/anthropic": Model.KnownProviderEnum.googleVertexAnthropic,
	"@ai-sdk/openai": Model.KnownProviderEnum.openai,
	"@ai-sdk/openai-compatible": Model.KnownProviderEnum.openaiCompatible,
	"@openrouter/ai-sdk-provider": Model.KnownProviderEnum.openrouter,
	"@ai-sdk/xai": Model.KnownProviderEnum.xai,
} as const;

export type AISDKPackage = keyof typeof AI_SDK_PACKAGE_TO_PROTOCOL;
export type AISDKProtocol = (typeof AI_SDK_PACKAGE_TO_PROTOCOL)[AISDKPackage];

type ProviderFactory = (options?: Record<string, unknown>) => unknown;

const PROVIDER_LOADERS: Record<AISDKPackage, () => Promise<ProviderFactory>> = {
	"@ai-sdk/anthropic": () => import("@ai-sdk/anthropic").then((m) => m.createAnthropic as ProviderFactory),
	"@ai-sdk/google": () => import("@ai-sdk/google").then((m) => m.createGoogleGenerativeAI as ProviderFactory),
	"@ai-sdk/google-vertex": () => import("@ai-sdk/google-vertex").then((m) => m.createVertex as ProviderFactory),
	"@ai-sdk/google-vertex/anthropic": () =>
		import("@ai-sdk/google-vertex/anthropic").then((m) => m.createVertexAnthropic as ProviderFactory),
	"@ai-sdk/openai": () => import("@ai-sdk/openai").then((m) => m.createOpenAI as ProviderFactory),
	"@ai-sdk/openai-compatible": () =>
		import("@ai-sdk/openai-compatible").then((m) => m.createOpenAICompatible as unknown as ProviderFactory),
	"@openrouter/ai-sdk-provider": () =>
		import("@openrouter/ai-sdk-provider").then((m) => m.createOpenRouter as ProviderFactory),
	"@ai-sdk/xai": () => import("@ai-sdk/xai").then((m) => m.createXai as ProviderFactory),
};

export function isAISDKPackage(value: string): value is AISDKPackage {
	return value in AI_SDK_PACKAGE_TO_PROTOCOL;
}

export function packageForModel(model: Model.Info): AISDKPackage {
	const npm = model.npm ?? DEFAULT_AI_SDK_PACKAGE;
	return isAISDKPackage(npm) ? npm : DEFAULT_AI_SDK_PACKAGE;
}

export function protocolForPackage(npm: string | undefined): AISDKProtocol {
	const resolved = npm && isAISDKPackage(npm) ? npm : DEFAULT_AI_SDK_PACKAGE;
	return AI_SDK_PACKAGE_TO_PROTOCOL[resolved];
}

export async function loadProviderFactory(npm: AISDKPackage): Promise<ProviderFactory> {
	return PROVIDER_LOADERS[npm]();
}

type ProviderWithMethods = {
	(modelId: string): LanguageModel;
	languageModel?: (modelId: string) => LanguageModel;
	chat?: (modelId: string) => LanguageModel;
	chatModel?: (modelId: string) => LanguageModel;
	completion?: (modelId: string) => LanguageModel;
	completionModel?: (modelId: string) => LanguageModel;
	messages?: (modelId: string) => LanguageModel;
	responses?: (modelId: string) => LanguageModel;
};

function defaultMethodForModel(model: Model.Info): Model.APIMethodEnum {
	if (model.protocol === Model.KnownProviderEnum.openai || model.protocol === Model.KnownProviderEnum.xai) {
		return Model.APIMethodEnum.responses;
	}
	return Model.APIMethodEnum.languageModel;
}

export function resolveLanguageModel(
	provider: unknown,
	model: Model.Info,
	methodOverride?: Model.APIMethodEnum,
): LanguageModel {
	const modelId = model.api?.id ?? model.id;
	const method = methodOverride ?? model.api?.method ?? defaultMethodForModel(model);
	const callable = provider as ProviderWithMethods;

	if (method === Model.APIMethodEnum.responses && callable.responses) return callable.responses(modelId);
	if (method === Model.APIMethodEnum.messages && callable.messages) return callable.messages(modelId);
	if (method === Model.APIMethodEnum.chat) {
		if (callable.chat) return callable.chat(modelId);
		if (callable.chatModel) return callable.chatModel(modelId);
	}
	if (method === Model.APIMethodEnum.completion) {
		if (callable.completion) return callable.completion(modelId);
		if (callable.completionModel) return callable.completionModel(modelId);
	}
	if (method === Model.APIMethodEnum.completionModel && callable.completionModel) {
		return callable.completionModel(modelId);
	}
	if (callable.languageModel) return callable.languageModel(modelId);
	return callable(modelId);
}
