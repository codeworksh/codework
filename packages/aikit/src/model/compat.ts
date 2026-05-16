import type { Model } from "./model";
import type { ModelFlag } from "./flag";

export namespace ModelCompat {
	type ResolvedOpenAICompletionsCompat = Omit<Required<ModelFlag.OpenAICompletionsCompat>, "cacheControlFormat"> & {
		cacheControlFormat?: ModelFlag.OpenAICompletionsCompat["cacheControlFormat"];
	};
	export function handleOpenAICompletions(model: Model.Info): ResolvedOpenAICompletionsCompat {
		const provider: string = model.provider.id;
		const baseUrl = model.baseUrl;

		const isZai = provider === "zai" || baseUrl.includes("api.z.ai");
		const isTogether =
			provider === "together" || baseUrl.includes("api.together.ai") || baseUrl.includes("api.together.xyz");
		const isMoonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
		const isCloudflareWorkersAI = provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");
		const isCloudflareAiGateway =
			provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");

		const isNonStandard =
			provider === "cerebras" ||
			baseUrl.includes("cerebras.ai") ||
			provider === "xai" ||
			baseUrl.includes("api.x.ai") ||
			isTogether ||
			baseUrl.includes("chutes.ai") ||
			baseUrl.includes("deepseek.com") ||
			isZai ||
			isMoonshot ||
			provider === "opencode" ||
			baseUrl.includes("opencode.ai") ||
			isCloudflareWorkersAI ||
			isCloudflareAiGateway;

		const useMaxTokens = baseUrl.includes("chutes.ai") || isMoonshot || isCloudflareAiGateway || isTogether;

		const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
		const isDeepSeek = provider === "deepseek" || baseUrl.includes("deepseek.com");
		const cacheControlFormat =
			provider === "openrouter" && model.id.startsWith("anthropic/") ? "anthropic" : undefined;

		return {
			supportsStore: !isNonStandard,
			supportsDeveloperRole: !isNonStandard,
			supportsReasoningEffort: !isGrok && !isZai && !isMoonshot && !isTogether && !isCloudflareAiGateway,
			supportsUsageInStreaming: true,
			maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
			requiresToolResultName: false,
			requiresAssistantAfterToolResult: false,
			requiresThinkingAsText: false,
			requiresReasoningContentOnAssistantMessages: isDeepSeek,
			thinkingFormat: isDeepSeek
				? "deepseek"
				: isZai
					? "zai"
					: isTogether
						? "together"
						: provider === "openrouter" || baseUrl.includes("openrouter.ai")
							? "openrouter"
							: "openai",
			openRouterRouting: {},
			vercelGatewayRouting: {},
			zaiToolStream: false,
			supportsStrictMode: !isMoonshot && !isTogether && !isCloudflareAiGateway,
			cacheControlFormat,
			sendSessionAffinityHeaders: false,
			supportsLongCacheRetention: !(isTogether || isCloudflareWorkersAI || isCloudflareAiGateway),
		};
	}

	export function handleAnthropicMessages(model: Model.Info): Required<ModelFlag.AnthropicMessagesCompat> {
		// Auto-detect session affinity and cache control support from provider
		const provider: string = model.provider.id;
		const baseUrl = model.baseUrl;
		const compat = model.compat as ModelFlag.AnthropicMessagesCompat;

		const isFireworks = provider === "fireworks";
		const isCloudflareAiGatewayAnthropic = provider === "cloudflare-ai-gateway" && baseUrl.includes("anthropic");
		return {
			supportsEagerToolInputStreaming: compat?.supportsEagerToolInputStreaming ?? !isFireworks,
			supportsLongCacheRetention: compat?.supportsLongCacheRetention ?? !isFireworks,
			sendSessionAffinityHeaders:
				compat?.sendSessionAffinityHeaders ?? !!(isFireworks || isCloudflareAiGatewayAnthropic),
			supportsCacheControlOnTools: compat?.supportsCacheControlOnTools ?? !isFireworks,
		};
	}
}
