import { lazy } from "@codeworksh/utils";
import { type Static, Type } from "@sinclair/typebox";
import { keys, mapValues, pick, pipe } from "remeda";
import { Provider } from "../provider/provider";
import { ModelCatalog } from "./catalog";

export namespace Model {
	export const KnownProtocolEnum = {
		anthropicMessages: "anthropic-messages",
		openaiCompletions: "openai-completions",
		openaiResponses: "openai-responses",
	} as const;
	export const KnownProtocolSchema = Type.Union([
		Type.Literal(KnownProtocolEnum.anthropicMessages),
		Type.Literal(KnownProtocolEnum.openaiCompletions),
		Type.Literal(KnownProtocolEnum.openaiResponses),
	]);
	export type KnownProtocol = Static<typeof KnownProtocolSchema>;

	const InputSchema = Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]));
	const CostSchema = Type.Object({
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
	});
	const HeadersSchema = Type.Optional(Type.Record(Type.String(), Type.String()));
	export const BaseSchema = Type.Object({
		id: Type.String(),
		name: Type.String(),
		provider: Provider.Info,
		baseUrl: Type.String(),
		reasoning: Type.Boolean(),
		input: InputSchema,
		cost: CostSchema,
		contextWindow: Type.Number(),
		maxTokens: Type.Number(),
		headers: HeadersSchema,
	});

	/**
	 * Compatibility settings for OpenAI-compatible completions APIs.
	 * Use this to override URL-based auto-detection for custom providers.
	 */
	export const OpenAICompletionsCompatSchema = Type.Object({
		supportsStore: Type.Optional(Type.Boolean()),
		supportsDeveloperRole: Type.Optional(Type.Boolean()),
		supportsReasoningEffort: Type.Optional(Type.Boolean()),
		reasoningEffortMap: Type.Optional(Provider.ReasoningEffortMapSchema),
		supportsUsageInStreaming: Type.Optional(Type.Boolean()),
		maxTokensField: Type.Optional(Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")])),
		requiresToolResultName: Type.Optional(Type.Boolean()),
		requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
		requiresThinkingAsText: Type.Optional(Type.Boolean()),
		thinkingFormat: Type.Optional(
			Type.Union([
				Type.Literal("openai"),
				Type.Literal("openrouter"),
				Type.Literal("zai"),
				Type.Literal("qwen"),
				Type.Literal("qwen-chat-template"),
			]),
		),
		openRouterRouting: Type.Optional(Provider.OpenRouterRoutingSchema),
		vercelGatewayRouting: Type.Optional(Provider.VercelGatewayRoutingSchema),
    zaiToolStream: Type.Optional(Type.Boolean()),
		supportsStrictMode: Type.Optional(Type.Boolean()),
	});
	export type OpenAICompletionsCompat = Static<typeof OpenAICompletionsCompatSchema>;

	/** Compatibility settings for OpenAI Responses APIs. */
	export const OpenAIResponsesCompatSchema = Type.Object({});
	export type OpenAIResponsesCompat = Static<typeof OpenAIResponsesCompatSchema>;

	export const OpenAICompatSchema = Type.Union([OpenAICompletionsCompatSchema, OpenAIResponsesCompatSchema]);

	export const AnthropicSchema = Type.Composite([
		BaseSchema,
		Type.Object({
			protocol: Type.Literal(KnownProtocolEnum.anthropicMessages),
		}),
	]);

	export const OpenAICompletionsSchema = Type.Composite([
		BaseSchema,
		Type.Object({
			protocol: Type.Literal(KnownProtocolEnum.openaiCompletions),
			compat: Type.Optional(OpenAICompletionsCompatSchema),
		}),
	]);
	export const OpenAIResponsesSchema = Type.Composite([
		BaseSchema,
		Type.Object({
			protocol: Type.Literal(KnownProtocolEnum.openaiResponses),
			compat: Type.Optional(OpenAIResponsesCompatSchema),
		}),
	]);

	export const Schema = Type.Union([AnthropicSchema, OpenAICompletionsSchema, OpenAIResponsesSchema]);
	export type Value = Static<typeof Schema>;
	export type TModel<TProtocol extends KnownProtocol> = Extract<Value, { protocol: TProtocol }>;
	const BUILTINS = keys(Provider.KnownProviderEnum) as Provider.KnownProvider[];

	export function calculateCost(
		model: Value,
		usage: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
				total: number;
			};
		},
	): void {
		usage.cost.input = (usage.input / 1_000_000) * model.cost.input;
		usage.cost.output = (usage.output / 1_000_000) * model.cost.output;
		usage.cost.cacheRead = (usage.cacheRead / 1_000_000) * model.cost.cacheRead;
		usage.cost.cacheWrite = (usage.cacheWrite / 1_000_000) * model.cost.cacheWrite;
		usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	}

	export type BuiltInModels = Partial<Record<Provider.KnownProvider, Record<string, Value>>>;

	function resolveProtocol(providerId: Provider.KnownProvider): KnownProtocol {
		switch (providerId) {
			case Provider.KnownProviderEnum.anthropic:
				return KnownProtocolEnum.anthropicMessages;
			case Provider.KnownProviderEnum.openai:
				return KnownProtocolEnum.openaiResponses;
		}
	}

	function normalizeInput(input?: string[]): Array<"text" | "image"> {
		const normalized = new Set<"text" | "image">();
		for (const modality of input ?? ["text"]) {
			if (modality === "text" || modality === "image") {
				normalized.add(modality);
			}
		}
		if (normalized.size === 0) normalized.add("text");
		return [...normalized];
	}

	function toProviderInfo(
		providerId: Provider.KnownProvider,
		provider: ModelCatalog.ModelsDevProvider,
	): Provider.Info {
		return {
			id: providerId,
			name: provider.name,
			env: provider.env,
			key: provider.key,
			options: provider.headers,
		};
	}

	function toModelValue(
		providerId: Provider.KnownProvider,
		provider: ModelCatalog.ModelsDevProvider,
		model: ModelCatalog.ModelsDevModel,
	): Value {
		const baseUrl = model.baseUrl ?? provider.baseUrl ?? provider.api;
		const normalized: Value = {
			id: model.id,
			name: model.name,
			provider: toProviderInfo(providerId, provider),
			baseUrl,
			reasoning: Boolean(model.reasoning),
			input: normalizeInput(model.modalities.input),
			cost: {
				input: model.cost?.input ?? 0,
				output: model.cost?.output ?? 0,
				cacheRead: model.cost?.cache_read ?? 0,
				cacheWrite: model.cost?.cache_write ?? 0,
			},
			contextWindow: model.limit?.context ?? 0,
			maxTokens: model.limit?.output ?? 0,
			headers: model.headers ?? provider.headers,
			protocol: resolveProtocol(providerId),
		};
		return normalized;
	}

	export async function getBuiltInModels(): Promise<BuiltInModels> {
		const catalog = await ModelCatalog.get();
		return pipe(
			catalog,
			pick(BUILTINS),
			mapValues((provider, providerId) =>
				mapValues(provider.models, (model) => toModelValue(providerId as Provider.KnownProvider, provider, model)),
			),
		) as BuiltInModels;
	}

	export const registry = lazy(async () => {
		const registry: Map<Provider.KnownProvider, Map<string, Value>> = new Map();
		const models = await getBuiltInModels();
		for (const [provider, value] of Object.entries(models) as Array<
			[Provider.KnownProvider, Record<string, Value>]
		>) {
			const providerModels = new Map<string, Value>();
			for (const [id, model] of Object.entries(value)) {
				providerModels.set(id, model);
			}
			registry.set(provider, providerModels);
		}
		return registry;
	});

	export async function getModel<TProvider extends Provider.KnownProvider, TModel extends Value["id"]>(
		provider: TProvider,
		model: TModel,
	) {
		const data = await registry();
		const providerModels = data.get(provider);
		return providerModels?.get(model);
	}

	export async function getProviders(): Promise<Provider.KnownProvider[]> {
		const data = await registry();
		return Array.from(data.keys());
	}

	export async function getModels<TProvider extends Provider.KnownProvider>(provider: TProvider): Promise<Value[]> {
		const data = await registry();
		const models = data.get(provider);
		return models ? Array.from(models.values()) : [];
	}

	function isGpt5OrLater(modelID: string): boolean {
		const match = /^gpt-(\d+)/.exec(modelID);
		if (!match) {
			return false;
		}
		return Number(match[1]) >= 5;
	}

	/**
	 * Check if a model supports xhigh thinking level.
	 * Currently only certain OpenAI Codex models support this.
	 */
	export function supportsXhigh(model: Value): boolean {
		return isGpt5OrLater(model.id);
	}

	/**
	 * Check if two models are equal by comparing both their id and provider id.
	 * Returns false if either model is null or undefined.
	 */
	export function modelsAreEqual(a: Value | null | undefined, b: Value | null | undefined): boolean {
		if (!a || !b) return false;
		return a.id === b.id && a.provider.id === b.provider.id;
	}
}
