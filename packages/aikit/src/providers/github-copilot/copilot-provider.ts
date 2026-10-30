/**
 * GitHub Copilot provider.
 *
 * Copilot exposes three inference protocols on one host — OpenAI Chat
 * Completions (`/chat/completions`), OpenAI Responses (`/responses`), and
 * Anthropic Messages (`/v1/messages`) — so this provider routes each model
 * through `api.method`. Chat and Messages use the official AI SDK adapters;
 * Responses uses aikit's own Responses model, which declares tools added
 * mid-conversation in place. Auth and Copilot request headers are applied inside
 * the shared fetch wrapper, which is why the adapters receive a placeholder key:
 * their headers never reach the wire.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { NoSuchModelError, type LanguageModelV3, type LanguageModelV4, type ProviderV4 } from "@ai-sdk/provider";
import {
	ResponsesLanguageModel,
	type ResponsesCompatibility,
	type ResponsesRequestProfile,
} from "../responses/model.ts";
import { createCopilotFetch, type GitHubCopilotApiKey } from "./copilot-fetch.ts";
import type { GitHubCopilotInteractionType } from "./copilot-headers.ts";

export const GITHUB_COPILOT_DEFAULT_BASE_URL = "https://api.githubcopilot.com";
export const GITHUB_COPILOT_PROVIDER_NAME = "github-copilot";

const PLACEHOLDER_API_KEY = "github-copilot";

/** The copilot fetch reads the JSON body for its headers, so it goes uncompressed. */
const COPILOT_RESPONSES_REQUEST: ResponsesRequestProfile = {
	systemPrompt: "developer",
	maxOutputTokens: true,
	encryptedReasoning: "withEffort",
	compress: false,
	toolDefaults: false,
};

export interface GitHubCopilotProvider extends ProviderV4 {
	/** Chat Completions — the generic fallback for third-party models. */
	(modelId: string): LanguageModelV4;
	languageModel(modelId: string): LanguageModelV4;
	/** `POST /chat/completions` — Gemini, Kimi, and other third-party models. */
	chat(modelId: string): LanguageModelV4;
	/** `POST /responses` — GPT, Grok, OSWE, and MAI models. */
	responses(modelId: string): LanguageModelV3;
	/** `POST /v1/messages` — Claude models. */
	messages(modelId: string): LanguageModelV4;
}

export interface GitHubCopilotProviderSettings {
	/**
	 * Copilot API host. Defaults to `https://api.githubcopilot.com`; OAuth
	 * credentials can carry a plan-specific `apiEndpoint` that overrides this.
	 */
	baseURL?: string;
	/**
	 * GitHub OAuth token (`ghu_`/`gho_`) or an async resolver, e.g.
	 * `() => getGitHubCopilotApiKey()`. Falls back to `COPILOT_GITHUB_TOKEN`.
	 */
	apiKey?: GitHubCopilotApiKey;
	/** Extra headers merged into every request. */
	headers?: Record<string, string>;
	/** Custom fetch implementation, applied underneath the Copilot wrapper. */
	fetch?: typeof globalThis.fetch;
	/** Sent as `X-Interaction-Id` so Copilot can group requests by session. */
	sessionId?: string;
	interactionType?: GitHubCopilotInteractionType;
	/** Forwarded to the Chat Completions adapter only. */
	transformRequestBody?: (body: Record<string, unknown>) => Record<string, unknown>;
	/** Sent as `prompt_cache_key` on Responses requests. */
	promptCacheKey?: string;
	/** Responses model capabilities supplied by aikit; absent flags are disabled. */
	compat?: ResponsesCompatibility;
}

export function createGitHubCopilot(options: GitHubCopilotProviderSettings = {}): GitHubCopilotProvider {
	const baseURL = (options.baseURL ?? GITHUB_COPILOT_DEFAULT_BASE_URL).replace(/\/+$/, "");
	const fetch = createCopilotFetch({
		...(options.apiKey !== undefined && { apiKey: options.apiKey }),
		...(options.fetch !== undefined && { fetch: options.fetch }),
		...(options.sessionId !== undefined && { sessionId: options.sessionId }),
		...(options.interactionType !== undefined && { interactionType: options.interactionType }),
	});
	const headers = options.headers !== undefined ? { headers: options.headers } : {};

	const chat = createOpenAICompatible({
		name: GITHUB_COPILOT_PROVIDER_NAME,
		baseURL,
		apiKey: PLACEHOLDER_API_KEY,
		...headers,
		fetch,
		includeUsage: true,
		...(options.transformRequestBody !== undefined && { transformRequestBody: options.transformRequestBody }),
	});
	const responses = (modelId: string) =>
		new ResponsesLanguageModel(modelId, {
			provider: GITHUB_COPILOT_PROVIDER_NAME,
			label: "GitHub Copilot",
			url: `${baseURL}/responses`,
			headers: () => ({ ...options.headers, accept: "text/event-stream", "content-type": "application/json" }),
			fetch,
			request: COPILOT_RESPONSES_REQUEST,
			...(options.promptCacheKey !== undefined && { promptCacheKey: options.promptCacheKey }),
			...(options.compat !== undefined && { compat: options.compat }),
		});
	const messages = createAnthropic({
		name: GITHUB_COPILOT_PROVIDER_NAME,
		// The Anthropic adapter appends /messages to its baseURL.
		baseURL: `${baseURL}/v1`,
		authToken: PLACEHOLDER_API_KEY,
		...headers,
		fetch,
	});

	const provider = function (modelId: string): LanguageModelV4 {
		if (new.target) {
			throw new Error("github copilot model function cannot be called with the new keyword.");
		}
		return chat.chatModel(modelId);
	};
	provider.specificationVersion = "v4" as const;
	provider.languageModel = (modelId: string) => chat.chatModel(modelId);
	provider.chat = (modelId: string) => chat.chatModel(modelId);
	provider.responses = responses;
	provider.messages = (modelId: string) => messages.messages(modelId);
	provider.embeddingModel = (modelId: string) => {
		throw new NoSuchModelError({
			modelId,
			modelType: "embeddingModel",
			message: "github copilot does not expose embedding models",
		});
	};
	provider.textEmbeddingModel = provider.embeddingModel;
	provider.imageModel = (modelId: string) => {
		throw new NoSuchModelError({
			modelId,
			modelType: "imageModel",
			message: "github copilot does not expose image models",
		});
	};

	return provider;
}

export const githubCopilot = createGitHubCopilot();
