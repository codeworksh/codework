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

/**
 * Inject a thinking-token budget the AI SDK has no field for.
 *
 * `@ai-sdk/openai-compatible` validates provider options against a closed schema,
 * so an endpoint-specific budget field cannot travel that way. `transformRequestBody`
 * is the SDK's own hook for exactly this: the last edit before the body is sent.
 */
export function thinkingTokenBudgetTransform(
	field: string,
	budget: number,
	existing: unknown,
): (body: Record<string, unknown>) => Record<string, unknown> {
	const chain =
		typeof existing === "function"
			? (existing as (body: Record<string, unknown>) => Record<string, unknown>)
			: undefined;
	return (body) => {
		const transformed = chain ? chain(body) : body;
		return { ...transformed, [field]: budget };
	};
}

export async function resolveAISDKLanguageModel(
	model: Model.Info,
	options: Options,
	thinkingTokenBudget?: number,
): Promise<LanguageModel> {
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

		const budgetField = Model.thinkingTokenBudgetField(model);
		if (budgetField && thinkingTokenBudget !== undefined && thinkingTokenBudget > 0) {
			factoryOptions.transformRequestBody = thinkingTokenBudgetTransform(
				budgetField,
				thinkingTokenBudget,
				factoryOptions.transformRequestBody,
			);
		}
	}

	if (npm === "@codeworksh/ai-sdk-openai-codex") {
		// Codex uses the session id for the session-id header and prompt cache key.
		const cacheDisabled =
			options.cacheRetention === "none" ||
			(typeof process !== "undefined" && process.env.CODEWORK_CACHE_RETENTION === "none");
		if (options.sessionId && !cacheDisabled) factoryOptions.sessionId ??= options.sessionId;
		factoryOptions.compat = {
			...model.compat,
			supportsImages: model.input.includes("image"),
			...(typeof factoryOptions.compat === "object" && factoryOptions.compat !== null ? factoryOptions.compat : {}),
		};
	}

	const provider = createProvider(factoryOptions);
	return resolveLanguageModel(provider, model, options.method);
}
