import { LoadAPIKeyError, NoSuchModelError, type LanguageModelV3, type ProviderV3 } from "@ai-sdk/provider";
import { getOpenAICodexAccountId } from "../../oauth/openai/codex.ts";
import {
	OPENAI_CODEX_DEFAULT_BASE_URL,
	OpenAICodexLanguageModel,
	clampOpenAICodexPromptCacheKey,
	type OpenAICodexModelId,
	type OpenAICodexCompatibility,
	type OpenAICodexServiceTier,
} from "./codex-language-model.ts";

export const OPENAI_CODEX_API_KEY_ENV = "OPENAI_CODEX_API_KEY";

const DEFAULT_ORIGINATOR = "codework";

export interface OpenAICodexProvider extends ProviderV3 {
	(modelId: OpenAICodexModelId): LanguageModelV3;

	languageModel(modelId: OpenAICodexModelId): LanguageModelV3;

	/** Alias for `languageModel`; the Codex API only speaks the Responses protocol. */
	responses(modelId: OpenAICodexModelId): LanguageModelV3;
}

export interface OpenAICodexProviderSettings {
	/**
	 * Base URL for the Codex backend.
	 * Defaults to `https://chatgpt.com/backend-api`.
	 */
	baseURL?: string;

	/**
	 * ChatGPT OAuth access token (JWT) used as the API key.
	 * Defaults to the `OPENAI_CODEX_API_KEY` environment variable.
	 * A function can be passed to resolve a fresh token per request.
	 */
	apiKey?: string | (() => string | PromiseLike<string>);

	/**
	 * ChatGPT account id sent as the `chatgpt-account-id` header.
	 * Extracted from the JWT access token when omitted.
	 */
	accountId?: string;

	/** Custom headers merged into every request. */
	headers?: Record<string, string>;

	/** Custom fetch implementation. */
	fetch?: typeof globalThis.fetch;

	/** Session id used for request identity, the `session-id` header, and prompt cache affinity. */
	sessionId?: string;

	/** Default service tier for requests. */
	serviceTier?: OpenAICodexServiceTier;

	/** `originator` header value; defaults to `codework`. */
	originator?: string;

	/** Optional model capability overrides. Known Codex models use built-in defaults. */
	compat?: OpenAICodexCompatibility;
}

async function resolveApiKey(settings: OpenAICodexProviderSettings): Promise<string> {
	const apiKey =
		typeof settings.apiKey === "function"
			? await settings.apiKey()
			: (settings.apiKey ?? (typeof process === "undefined" ? undefined : process.env[OPENAI_CODEX_API_KEY_ENV]));

	if (!apiKey) {
		throw new LoadAPIKeyError({
			message: `OpenAI Codex API key is missing. Pass it using the 'apiKey' option or the ${OPENAI_CODEX_API_KEY_ENV} environment variable.`,
		});
	}

	return apiKey;
}

function resolveAccountId(settings: OpenAICodexProviderSettings, apiKey: string): string {
	const accountId = settings.accountId ?? getOpenAICodexAccountId(apiKey);
	if (!accountId) {
		throw new LoadAPIKeyError({
			message:
				"Failed to extract the ChatGPT account id from the OpenAI Codex access token. " +
				"Provide it using the 'accountId' option or pass a valid ChatGPT OAuth JWT as the API key.",
		});
	}
	return accountId;
}

export function createOpenAICodex(options: OpenAICodexProviderSettings = {}): OpenAICodexProvider {
	const baseURL = options.baseURL?.replace(/\/+$/, "") || OPENAI_CODEX_DEFAULT_BASE_URL;
	const sessionId = clampOpenAICodexPromptCacheKey(options.sessionId);

	const getHeaders = async (): Promise<Record<string, string | undefined>> => {
		const apiKey = await resolveApiKey(options);
		const accountId = resolveAccountId(options, apiKey);

		return {
			Authorization: `Bearer ${apiKey}`,
			"chatgpt-account-id": accountId,
			"OpenAI-Beta": "responses=experimental",
			originator: options.originator ?? DEFAULT_ORIGINATOR,
			accept: "text/event-stream",
			"content-type": "application/json",
			...(sessionId ? { "session-id": sessionId, "x-client-request-id": sessionId } : {}),
			...options.headers,
		};
	};

	const createLanguageModel = (modelId: OpenAICodexModelId) =>
		new OpenAICodexLanguageModel(modelId, {
			provider: "openai-codex",
			baseURL,
			headers: getHeaders,
			...(options.fetch !== undefined && { fetch: options.fetch }),
			...(sessionId !== undefined && { sessionId }),
			...(options.serviceTier !== undefined && { serviceTier: options.serviceTier }),
			...(options.compat !== undefined && { compat: options.compat }),
		});

	const provider = function (modelId: OpenAICodexModelId) {
		if (new.target) {
			throw new Error("The OpenAI Codex model function cannot be called with the new keyword.");
		}
		return createLanguageModel(modelId);
	};

	provider.specificationVersion = "v3" as const;
	provider.languageModel = createLanguageModel;
	provider.responses = createLanguageModel;

	provider.embeddingModel = (modelId: string) => {
		throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
	};
	provider.textEmbeddingModel = (modelId: string) => {
		throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
	};
	provider.imageModel = (modelId: string) => {
		throw new NoSuchModelError({ modelId, modelType: "imageModel" });
	};

	return provider as OpenAICodexProvider;
}

/**
 * Default provider instance using `OPENAI_CODEX_API_KEY`.
 */
export const openaiCodex = createOpenAICodex();
