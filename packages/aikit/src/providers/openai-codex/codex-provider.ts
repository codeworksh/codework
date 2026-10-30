import { LoadAPIKeyError, NoSuchModelError, type LanguageModelV3, type ProviderV3 } from "@ai-sdk/provider";
import type { TSchema } from "typebox";
import type * as Message from "../../message/message.ts";
import { getOpenAICodexAccountId } from "../../oauth/openai/codex.ts";
import {
	ResponsesLanguageModel,
	clampPromptCacheKey,
	type ResponsesCompatibility,
	type ResponsesRequestProfile,
	type ResponsesServiceTier,
} from "../responses/model.ts";

export const OPENAI_CODEX_API_KEY_ENV = "OPENAI_CODEX_API_KEY";
export const OPENAI_CODEX_DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";

export type OpenAICodexModelId =
	| "gpt-5.3-codex-spark"
	| "gpt-5.4"
	| "gpt-5.4-mini"
	| "gpt-5.5"
	| "gpt-5.6-luna"
	| "gpt-5.6-sol"
	| "gpt-5.6-terra"
	| (string & {});

export type OpenAICodexCompatibility = ResponsesCompatibility;

/**
 * The ChatGPT Codex backend requires `instructions`, rejects `max_output_tokens`, and
 * takes a zstd-compressed body.
 */
const CODEX_REQUEST: ResponsesRequestProfile = {
	systemPrompt: "instructions",
	maxOutputTokens: false,
	encryptedReasoning: "always",
	compress: true,
	toolDefaults: true,
	textVerbosity: "low",
};

/**
 * Resolve the Codex responses endpoint from a base URL that may already
 * include the `/codex` or `/codex/responses` suffix.
 */
export function resolveOpenAICodexUrl(baseUrl?: string): string {
	const raw = baseUrl?.trim() ? baseUrl : OPENAI_CODEX_DEFAULT_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

/** Tool helpers for Responses-only tool kinds. */
export const openAICodexTools = {
	custom<TParameters extends TSchema>(args: {
		name: string;
		description: string;
		parameters: TParameters;
		format: { type: "grammar"; syntax: "lark" | "regex"; definition: string };
	}): Message.Tool<TParameters> {
		return {
			name: args.name,
			description: args.description,
			parameters: args.parameters,
			constrainedSampling: {
				type: "grammar",
				variants:
					args.format.syntax === "lark"
						? { openai_lark: args.format.definition }
						: { openai_regex: args.format.definition },
			},
		};
	},
};

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
	serviceTier?: ResponsesServiceTier;

	/** `originator` header value; defaults to `codework`. */
	originator?: string;

	/** Model capabilities supplied by aikit or the direct caller; absent flags are disabled. */
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
	const sessionId = clampPromptCacheKey(options.sessionId);

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
		new ResponsesLanguageModel(modelId, {
			provider: "openai-codex",
			label: "OpenAI Codex",
			url: resolveOpenAICodexUrl(baseURL),
			headers: getHeaders,
			request: CODEX_REQUEST,
			...(options.fetch !== undefined && { fetch: options.fetch }),
			...(sessionId !== undefined && { promptCacheKey: sessionId }),
			...(options.serviceTier !== undefined && { serviceTier: options.serviceTier }),
			...(options.compat !== undefined && { compat: options.compat }),
		});

	const provider = function (modelId: OpenAICodexModelId) {
		if (new.target) {
			throw new Error("openAI codex model function cannot be called with the new keyword.");
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
