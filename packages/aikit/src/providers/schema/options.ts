import { Type, type Static } from "typebox";
import { type Model } from "../../model/model";

export const Transport = Type.Union([Type.Literal("sse"), Type.Literal("websocket"), Type.Literal("auto")]);
export type Transport = Static<typeof Transport>;

/**
 * Prompt cache retention preference. Providers map this to their supported values.
 * Default: "short".
 */
export const CacheRetention = Type.Union([Type.Literal("none"), Type.Literal("short"), Type.Literal("long")]);
export type CacheRetention = Static<typeof CacheRetention>;

export const GenerationOptions = Type.Object({
	maxTokens: Type.Optional(Type.Number()),
	temperature: Type.Optional(Type.Number()),
	topP: Type.Optional(Type.Number()),
	topK: Type.Optional(Type.Number()),
	stop: Type.Optional(Type.Array(Type.String())),
	cacheRetention: Type.Optional(CacheRetention),
	stream: Type.Boolean(),
});

// Common reasoning-effort levels used by adapters that expose model reasoning,
// thinking, or deliberation controls. Protocol-specific layers can map these
// values to native fields like OpenAI `reasoning_effort`, Anthropic `thinking`,
// or Gemini `thinkingConfig`.
export const ReasoningLevelEnum = {
	// Disable explicit reasoning controls when the provider supports turning them off.
	off: "off",

	// Smallest reasoning budget/effort above off; useful for fastest low-cost responses.
	minimal: "minimal",

	// Light reasoning for simple tasks that still benefit from some deliberation.
	low: "low",

	// Balanced default for general tasks.
	medium: "medium",

	// Higher reasoning effort for complex coding, analysis, or planning.
	high: "high",

	// Maximum reasoning effort for the hardest tasks where latency/cost tradeoffs are acceptable.
	xhigh: "xhigh",
} as const;

export const ReasoningLevel = Type.Union([
	Type.Literal(ReasoningLevelEnum.off),
	Type.Literal(ReasoningLevelEnum.minimal),
	Type.Literal(ReasoningLevelEnum.low),
	Type.Literal(ReasoningLevelEnum.medium),
	Type.Literal(ReasoningLevelEnum.high),
	Type.Literal(ReasoningLevelEnum.xhigh),
]);
export type ReasoningLevel = Static<typeof ReasoningLevel>;

export const ThinkingBudgets = Type.Object({
	off: Type.Optional(Type.Number()),
	minimal: Type.Optional(Type.Number()),
	low: Type.Optional(Type.Number()),
	medium: Type.Optional(Type.Number()),
	high: Type.Optional(Type.Number()),
});
export type ThinkingBudgets = Static<typeof ThinkingBudgets>;

export const HelperOptions = Type.Object({
	/**
	 * Optional custom HTTP headers to include in API requests.
	 * Merged with provider defaults; can override default headers.
	 * Not supported by all providers (e.g., AWS Bedrock uses SDK auth).
	 */
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	/**
	 * Optional session identifier for providers that support session-based caching.
	 * Providers can use this to enable prompt caching, request routing, or other
	 * session-aware features. Ignored by providers that don't support it.
	 */
	sessionId: Type.Optional(Type.String()),
	/**
	 * Preferred transport for providers that support multiple transports.
	 * Providers that do not support this option ignore it.
	 */
	transport: Type.Optional(Transport),
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 * For example, Anthropic uses `user_id` for abuse tracking and rate limiting.
	 */
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	apiKey: Type.Optional(Type.String()),
	/**
	 * HTTP request timeout in milliseconds for providers/SDKs that support it.
	 * For example, OpenAI and Anthropic SDK clients default to 10 minutes.
	 */
	timeoutMs: Type.Optional(Type.Number()),
	/**
	 * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
	 * If the server's requested delay exceeds this value, the request fails immediately
	 * with an error containing the requested delay, allowing higher-level retry logic
	 * to handle it with user visibility.
	 * Default: 60000 (60 seconds). Set to 0 to disable the cap.
	 */
	retryDelayMaxMs: Type.Optional(Type.Number()),
	/**
	 * Maximum retry attempts for providers/SDKs that support client-side retries.
	 * For example, OpenAI and Anthropic SDK clients default to 2.
	 */
	maxRetries: Type.Optional(Type.Number()),
	signal: Type.Optional(Type.Unsafe<AbortSignal>({})),
	/**
	 * Optional callback for inspecting or replacing provider payloads before sending.
	 * Return undefined to keep the payload unchanged.
	 */
	onPayload: Type.Optional(
		Type.Unsafe<(payload: unknown, model: Model.TModel<Model.KnownProtocolEnum>) => unknown>({}),
	),
});

export const SharedOptions = Type.Evaluate(Type.Intersect([GenerationOptions, HelperOptions]));
export type SharedOptions = Static<typeof SharedOptions>;
