import type { ModelCatalog } from "./catalog";
import { Model } from "./model";

function defaultBaseUrl(providerId: Model.KnownProviderEnum): string | undefined {
	switch (providerId) {
		case Model.KnownProviderEnum.openai:
			return "https://api.openai.com/v1";
		default:
			return undefined;
	}
}

function resolveDefaultProtocol(providerId: Model.KnownProviderEnum): Model.KnownProtocolEnum {
	switch (providerId) {
		case Model.KnownProviderEnum.anthropic:
			return Model.KnownProtocolEnum.anthropicMessages;
		case Model.KnownProviderEnum.openai:
			return Model.KnownProtocolEnum.openaiResponses;
		default:
			return Model.KnownProtocolEnum.openaiCompletions;
	}
}

export function applyModification(
	providerId: Model.KnownProviderEnum,
	provider: ModelCatalog.ModelsDevProvider,
	model: ModelCatalog.ModelsDevModel,
): Model.Info {
	const baseUrl = model.baseUrl ?? provider.baseUrl ?? provider.api ?? defaultBaseUrl(providerId);
	const normalized: Model.Info = {
		id: model.id,
		name: model.name,
		provider: Model.toProviderInfo(providerId, provider),
		baseUrl,
		reasoning: Boolean(model.reasoning),
		input: Model.normalizeInput(model.modalities.input),
		cost: {
			input: model.cost?.input ?? 0,
			output: model.cost?.output ?? 0,
			cacheRead: model.cost?.cache_read ?? 0,
			cacheWrite: model.cost?.cache_write ?? 0,
		},
		contextWindow: model.limit?.context ?? 0,
		maxTokens: model.limit?.output ?? 0,
		headers: model.headers ?? provider.headers,
		protocol: resolveDefaultProtocol(providerId),
		structuredOutput: model.structured_output ?? false,
	};
	normalized.compat = Model.resolveCompat(normalized);
	//
	// add support for multiple known protocols
	if (providerId === Model.KnownProviderEnum.openai) {
		normalized.supportedProtocols = {
			openaiCompletions: Model.KnownProtocolEnum.openaiCompletions,
		};
		return normalized;
	} else {
		return normalized;
	}
}
