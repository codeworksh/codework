import type { JSONObject, LanguageModelV3FinishReason, LanguageModelV3Usage } from "@ai-sdk/provider";

export type OpenAICodexUsage = {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
	output_tokens_details?: { reasoning_tokens?: number };
};

export function convertOpenAICodexUsage(usage: OpenAICodexUsage | undefined): LanguageModelV3Usage {
	const inputTotal = usage?.input_tokens;
	const cachedTokens = usage?.input_tokens_details?.cached_tokens ?? 0;
	const cacheWriteTokens = usage?.input_tokens_details?.cache_write_tokens ?? 0;
	const outputTotal = usage?.output_tokens;
	const reasoningTokens = usage?.output_tokens_details?.reasoning_tokens ?? 0;

	return {
		inputTokens: {
			total: inputTotal,
			noCache: inputTotal === undefined ? undefined : Math.max(inputTotal - cachedTokens - cacheWriteTokens, 0),
			cacheRead: inputTotal === undefined ? undefined : cachedTokens,
			cacheWrite: inputTotal === undefined ? undefined : cacheWriteTokens,
		},
		outputTokens: {
			total: outputTotal,
			text: outputTotal === undefined ? undefined : outputTotal - reasoningTokens,
			reasoning: outputTotal === undefined ? undefined : reasoningTokens,
		},
		...(usage ? { raw: usage as JSONObject } : {}),
	};
}

export function mapOpenAICodexFinishReason(
	status: string | undefined,
	hasToolCalls: boolean,
	incompleteReason?: string,
): LanguageModelV3FinishReason {
	switch (status) {
		case "completed":
			return { unified: hasToolCalls ? "tool-calls" : "stop", raw: status };
		case "incomplete":
			return incompleteReason === "max_output_tokens"
				? { unified: "length", raw: `${status}.${incompleteReason}` }
				: { unified: "error", raw: incompleteReason ? `${status}.${incompleteReason}` : status };
		case "failed":
		case "cancelled":
			return { unified: "error", raw: status };
		case undefined:
			return { unified: "other", raw: undefined };
		default:
			return { unified: "stop", raw: status };
	}
}
