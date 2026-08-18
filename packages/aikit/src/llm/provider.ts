import type { LanguageModel } from "ai";
import * as Model from "../model/model.ts";
import type { Options } from "./options.ts";
import * as Protocol from "./protocol.ts";
import { loadProviderFactory, packageForModel, resolveLanguageModel } from "./registry.ts";
import { getEnvApiKey, mergeHeaders } from "./runtime.ts";

function cleanHeaders(headers: Record<string, string | null>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value !== null) result[key] = value;
	}
	return result;
}

function resolveBaseURL(model: Model.Info, options: Options): string | undefined {
	return (options.baseURL ?? model.api?.url ?? model.baseUrl) || undefined;
}

export async function resolveAISDKLanguageModel(model: Model.Info, options: Options): Promise<LanguageModel> {
	const npm = packageForModel(model);
	const createProvider = await loadProviderFactory(npm);
	const apiKey = options.apiKey ?? getEnvApiKey(model.provider);
	const headers = cleanHeaders(mergeHeaders(model.headers, options.headers));
	const baseURL = resolveBaseURL(model, options);

	const factoryOptions: Record<string, unknown> = {
		...model.options,
		...options.factoryOptions,
	};

	if (apiKey) factoryOptions.apiKey = apiKey;
	if (Object.keys(headers).length > 0) factoryOptions.headers = headers;
	if (baseURL) factoryOptions.baseURL = baseURL;

	if (npm === "@ai-sdk/openai-compatible") {
		if (!baseURL) {
			throw new Protocol.ProtocolAuthError({
				protocol: model.protocol,
				message: "AI SDK openai-compatible transport requires model.baseUrl, model.api.url, or options.baseURL",
			});
		}
		factoryOptions.name ??= model.provider.id;
		factoryOptions.includeUsage ??= true;
	}

	if (npm === "@codeworksh/ai-sdk-openai-codex") {
		// Codex uses the session id for the session-id header and prompt cache key.
		const cacheDisabled =
			options.cacheRetention === "none" ||
			(typeof process !== "undefined" && process.env.CODEWORK_CACHE_RETENTION === "none");
		if (options.sessionId && !cacheDisabled) factoryOptions.sessionId ??= options.sessionId;
		factoryOptions.compat ??= {
			...model.compat,
			supportsImages: model.input.includes("image"),
		};
	}

	const provider = createProvider(factoryOptions);
	return resolveLanguageModel(provider, model, options.method);
}
