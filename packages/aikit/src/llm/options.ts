import type { AnthropicLanguageModelOptions, AnthropicProviderSettings } from "@ai-sdk/anthropic";
import type { GoogleGenerativeAIProviderSettings, GoogleLanguageModelOptions } from "@ai-sdk/google";
import type { GoogleVertexProviderSettings } from "@ai-sdk/google-vertex";
import type { GoogleVertexAnthropicProviderSettings } from "@ai-sdk/google-vertex/anthropic";
import type {
	OpenAILanguageModelChatOptions,
	OpenAILanguageModelCompletionOptions,
	OpenAILanguageModelResponsesOptions,
	OpenAIProviderSettings,
} from "@ai-sdk/openai";
import type {
	OpenAICompatibleLanguageModelChatOptions,
	OpenAICompatibleLanguageModelCompletionOptions,
	OpenAICompatibleProviderSettings,
} from "@ai-sdk/openai-compatible";
import type { XaiLanguageModelChatOptions, XaiLanguageModelResponsesOptions, XaiProviderSettings } from "@ai-sdk/xai";
import type { OpenRouterProviderOptions, OpenRouterProviderSettings } from "@openrouter/ai-sdk-provider";
import { Type, type Static } from "typebox";
import { Model } from "../model/model";
import type { Protocol } from "./protocol";
import { SharedOptions, ThinkingBudgets } from "./shared";

export const Options = Type.Evaluate(
	Type.Intersect([
		SharedOptions,
		Type.Object({
			baseURL: Type.Optional(Type.String()),
			method: Type.Optional(Model.APIMethodEnumSchema),
			modelId: Type.Optional(Type.String()),
			reasoning: Type.Optional(Model.ActiveThinkingLevel),
			thinkingBudgets: Type.Optional(ThinkingBudgets),
			toolChoice: Type.Optional(Type.Any()),
			activeTools: Type.Optional(Type.Array(Type.String())),
			factoryOptions: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			providerOptions: Type.Optional(Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown()))),
		}),
	]),
);

type ProviderOptionBag = Record<string, Record<string, unknown> | undefined>;

export type AISDKOptions<
	TFactoryOptions,
	TProviderOptions extends ProviderOptionBag = ProviderOptionBag,
> = Protocol.CommonOptions & {
	baseURL?: string;
	method?: Model.APIMethodEnum;
	modelId?: string;
	toolChoice?: unknown;
	activeTools?: string[];
	factoryOptions?: Partial<TFactoryOptions> & Record<string, unknown>;
	providerOptions?: TProviderOptions & ProviderOptionBag;
};

type OpenAILanguageOptions =
	| OpenAILanguageModelResponsesOptions
	| OpenAILanguageModelChatOptions
	| OpenAILanguageModelCompletionOptions;
type OpenAICompatibleLanguageOptions =
	| OpenAICompatibleLanguageModelChatOptions
	| OpenAICompatibleLanguageModelCompletionOptions;
type XaiLanguageOptions = XaiLanguageModelResponsesOptions | XaiLanguageModelChatOptions;

export type OpenAIOptions = AISDKOptions<OpenAIProviderSettings, { openai?: OpenAILanguageOptions }>;
export type AnthropicOptions = AISDKOptions<AnthropicProviderSettings, { anthropic?: AnthropicLanguageModelOptions }>;
export type GoogleOptions = AISDKOptions<GoogleGenerativeAIProviderSettings, { google?: GoogleLanguageModelOptions }>;
export type GoogleVertexOptions = AISDKOptions<GoogleVertexProviderSettings>;
export type GoogleVertexAnthropicOptions = AISDKOptions<GoogleVertexAnthropicProviderSettings>;
export type OpenAICompatibleOptions = AISDKOptions<
	OpenAICompatibleProviderSettings,
	{ "openai-compatible"?: OpenAICompatibleLanguageOptions }
>;
export type OpenRouterOptions = AISDKOptions<OpenRouterProviderSettings, { openrouter?: OpenRouterProviderOptions }>;
export type XaiOptions = AISDKOptions<XaiProviderSettings, { xai?: XaiLanguageOptions }>;

export type Options = Static<typeof Options>;

declare module "./protocol" {
	export namespace Protocol {
		// Used for type inference
		// eslint-disable-next-line no-unused-vars -- declaration merging registers AI SDK protocol options.
		interface OptionsByProtocol {
			[Model.KnownProviderEnum.openai]: OpenAIOptions;
			[Model.KnownProviderEnum.anthropic]: AnthropicOptions;
			[Model.KnownProviderEnum.google]: GoogleOptions;
			[Model.KnownProviderEnum.googleVertex]: GoogleVertexOptions;
			[Model.KnownProviderEnum.googleVertexAnthropic]: GoogleVertexAnthropicOptions;
			[Model.KnownProviderEnum.openaiCompatible]: OpenAICompatibleOptions;
			[Model.KnownProviderEnum.openrouter]: OpenRouterOptions;
			[Model.KnownProviderEnum.xai]: XaiOptions;
		}
	}
}
