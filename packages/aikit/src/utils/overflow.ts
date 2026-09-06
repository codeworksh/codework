import type * as Message from "../message/message.ts";

/**
 * Regex patterns to detect context overflow errors from different providers.
 *
 * These patterns match error messages returned when the input exceeds
 * the model's context window.
 *
 * Provider-specific patterns (with example error messages):
 *
 * - Anthropic: "prompt is too long: 213462 tokens > 200000 maximum"
 * - OpenAI: "Your input exceeds the context window of this model"
 * - Google: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"
 * - xAI: "This model's maximum prompt length is 131072 but the request contains 537812 tokens"
 * - Groq: "Please reduce the length of the messages or completion"
 * - OpenRouter: "This endpoint's maximum context length is X tokens. However, you requested about Y tokens"
 * - llama.cpp: "the request exceeds the available context size, try increasing it"
 * - LM Studio: "tokens to keep from the initial prompt is greater than the context length"
 * - GitHub Copilot: "prompt token count of X exceeds the limit of Y"
 * - MiniMax: "invalid params, context window exceeds limit"
 * - Kimi For Coding: "Your request exceeded model token limit: X (requested: Y)"
 * - Cerebras: Returns "400/413 status code (no body)" - handled separately below
 * - Mistral: Returns "400/413 status code (no body)" - handled separately below
 * - z.ai: Does NOT error, accepts overflow silently - handled via usage.input > contextWindow
 * - Ollama: Silently truncates input - not detectable via error message
 */
const OVERFLOW_PATTERNS = [
	/prompt is too long/i, // Anthropic token overflow
	/request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
	/input is too long for requested model/i, // Amazon Bedrock
	/exceeds the context window/i, // OpenAI (Completions & Responses API)
	/exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies (LiteLLM)
	/input token count.*exceeds the maximum/i, // Google (Gemini)
	/maximum prompt length is \d+/i, // xAI (Grok)
	/reduce the length of the messages/i, // Groq
	/maximum context length is \d+ tokens/i, // OpenRouter (most backends)
	/exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter / Poolside
	/input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
	/exceeds the limit of \d+/i, // GitHub Copilot
	/exceeds the available context size/i, // llama.cpp server
	/greater than the context length/i, // LM Studio
	/context window exceeds limit/i, // MiniMax
	/exceeded model token limit/i, // Kimi For Coding
	/too large for model with \d+ maximum context length/i, // Mistral
	/prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
	/model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
	/prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
	/range of input length should be/i, // DashScope / Qwen Token Plan
	/context[_ ]length[_ ]exceeded/i, // Generic fallback
	/too many tokens/i, // Generic fallback
	/token limit exceeded/i, // Generic fallback
	/^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i, // Cerebras / Mistral: 400 or 413 with no body
];

/**
 * Patterns that indicate a non-overflow error, such as rate limiting.
 *
 * Checked first: an error matching one of these is never an overflow, even when it
 * also matches an OVERFLOW_PATTERN. Bedrock, for instance, formats throttling as
 * "ThrottlingException: Too many tokens, please wait before trying again", which
 * would otherwise match `/too many tokens/i` and send a caller off to compact a
 * conversation that was never too long.
 */
const NON_OVERFLOW_PATTERNS = [
	/^(Throttling error|Service unavailable):/i, // AWS Bedrock, via formatBedrockError's human-readable prefixes
	/rate limit/i, // Generic rate limiting
	/too many requests/i, // Generic HTTP 429 style
];

/**
 * Check if an assistant message represents a context overflow error.
 *
 * This handles three cases:
 * 1. Error-based overflow: Most providers return stopReason "error" with a
 *    specific error message pattern. Rate-limit and throttling errors are
 *    excluded first, since some of them read like overflow.
 * 2. Silent overflow: Some providers accept overflow requests and return
 *    successfully. For these, we check if usage.input exceeds the context window.
 * 3. Length-stop overflow: Some providers truncate an oversized input to fit the
 *    window, which leaves no room to generate and stops on "length" with no output.
 *
 * ## Reliability by Provider
 *
 * **Reliable detection (returns error with detectable message):**
 * - Anthropic: "prompt is too long: X tokens > Y maximum"
 * - OpenAI (Completions & Responses): "exceeds the context window"
 * - Google Gemini: "input token count exceeds the maximum"
 * - xAI (Grok): "maximum prompt length is X but request contains Y"
 * - Groq: "reduce the length of the messages"
 * - Cerebras: 400/413 status code (no body)
 * - Mistral: 400/413 status code (no body)
 * - OpenRouter (all backends): "maximum context length is X tokens"
 * - llama.cpp: "exceeds the available context size"
 * - LM Studio: "greater than the context length"
 * - Kimi For Coding: "exceeded model token limit: X (requested: Y)"
 *
 * **Unreliable detection:**
 * - z.ai: Sometimes accepts overflow silently (detectable via usage.input > contextWindow),
 *   sometimes returns rate limit errors. Pass contextWindow param to detect silent overflow.
 * - Ollama: Some deployments return "prompt too long; exceeded context length" and are
 *   detected; others truncate silently, which this function cannot see -- the response
 *   has usage.input < expected, and the expected value is unknown.
 * - Xiaomi MiMo: Truncates to fill the window exactly, then stops on "length" with zero
 *   output. Pass contextWindow to detect it via case 3.
 *
 * ## Custom Providers
 *
 * If you've added custom models via settings.json, this function may not detect
 * overflow errors from those providers. To add support:
 *
 * 1. Send a request that exceeds the model's context window
 * 2. Check the errorMessage in the response
 * 3. Create a regex pattern that matches the error
 * 4. The pattern should be added to OVERFLOW_PATTERNS in this file, or
 *    check the errorMessage yourself before calling this function
 *
 * @param message - The assistant message to check
 * @param contextWindow - Optional context window size, needed for cases 2 and 3
 * @returns true if the message indicates a context overflow
 */
export function isContextOverflow(message: Message.AssistantMessage, contextWindow?: number): boolean {
	// Case 1: error message patterns
	if (message.stopReason === "error" && message.errorMessage) {
		const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!));
		if (!isNonOverflow && OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!))) {
			return true;
		}
	}

	// Case 2: silent overflow (z.ai style) -- the request succeeded but the input
	// it reports could not have fit.
	if (contextWindow && message.stopReason === "stop") {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens > contextWindow) {
			return true;
		}
	}

	// Case 3: length-stop overflow (Xiaomi MiMo style) -- the server truncated an
	// oversized input to fit the window, leaving no room to generate anything.
	if (contextWindow && message.stopReason === "length" && message.usage.output === 0) {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens >= contextWindow * 0.99) {
			return true;
		}
	}

	return false;
}

/**
 * Whether a length stop ended below the output limit that was actually asked for.
 *
 * Such a response was cut short by something other than the caller's own cap --
 * context pressure or provider-side truncation -- so one bounded compact-and-retry
 * is worth attempting. `desiredMaxOutput` must be the limit before any
 * context-based clamping, or a clamped request looks like a truncated one.
 */
export function isRecoverableLength(message: Message.AssistantMessage, desiredMaxOutput: number): boolean {
	return message.stopReason === "length" && desiredMaxOutput > 0 && message.usage.output < desiredMaxOutput;
}

/**
 * Get the overflow patterns for testing purposes.
 */
export function getOverflowPatterns(): RegExp[] {
	return [...OVERFLOW_PATTERNS];
}
