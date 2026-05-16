import { lazy } from "@codeworksh/utils";
import Type, { type Static } from "typebox";
import { keys, mapValues, pick, pipe } from "remeda";
import { ModelCatalog } from "./catalog";
import { applyModification } from "./transform";
import type { ModelFlag } from "./flag";
import { ModelCompat } from "./compat";

export namespace Model {
	// re-export
	export const KnownProtocolEnum = ModelCatalog.KnownProtocolEnum;
	export const KnownProtocolEnumSchema = ModelCatalog.KnownProtocolEnumSchema;
	export type KnownProtocolEnum = ModelCatalog.KnownProtocolEnum;

	export const KnownProviderEnum = ModelCatalog.KnownProviderEnum;
	export const KnownProviderEnumSchema = ModelCatalog.KnownProviderEnumSchema;
	export type KnownProviderEnum = ModelCatalog.KnownProviderEnum;

	export const ProviderInfo = Type.Object({
		id: KnownProviderEnumSchema,
		name: Type.String(),
		env: Type.Array(Type.String()),
		key: Type.Optional(Type.String()),
		options: Type.Optional(Type.Record(Type.String(), Type.Any())),
	});
	export type ProviderInfo = Static<typeof ProviderInfo>;

	const InputSchema = Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]));
	const CostSchema = Type.Object({
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
	});
	const SupportedProtocolsSchema = Type.Partial(
		Type.Object({
			anthropicMessages: KnownProtocolEnumSchema,
			openaiCompletions: KnownProtocolEnumSchema,
			openaiResponses: KnownProtocolEnumSchema,
		}),
	);
	type CompatFlags = ModelFlag.AnthropicMessagesCompat | ModelFlag.OpenAICompletionsCompat | Record<string, never>;

	export const Schema = Type.Object({
		id: Type.String(),
		name: Type.String(),
		provider: ProviderInfo,
		baseUrl: Type.String(),
		reasoning: Type.Boolean(),
		input: InputSchema,
		cost: CostSchema,
		contextWindow: Type.Number(),
		maxTokens: Type.Number(),
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		protocol: KnownProtocolEnumSchema,
		supportedProtocols: Type.Optional(SupportedProtocolsSchema),
	});

	export const ExtrasSchema = Type.Object({
		structuredOutput: Type.Boolean(),
	});

	export const CompatSchema = Type.Object({
		compat: Type.Optional(Type.Unsafe<CompatFlags>({})),
	});

	export const Info = Type.Evaluate(Type.Intersect([Schema, ExtrasSchema, CompatSchema]));
	export type Info = Static<typeof Info>;
	export type TModel<TProtocol extends KnownProtocolEnum> = Omit<Info, "protocol"> & { protocol: TProtocol };
	const BUILTINS = keys(KnownProviderEnum) as KnownProviderEnum[];

	export function calculateCost(
		model: Info,
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

	export type BuiltInModels = Partial<Record<KnownProviderEnum, Record<string, Info>>>;

	export function normalizeInput(input?: string[]): Array<"text" | "image"> {
		const normalized = new Set<"text" | "image">();
		for (const modality of input ?? ["text"]) {
			if (modality === "text" || modality === "image") {
				normalized.add(modality);
			}
		}
		if (normalized.size === 0) normalized.add("text");
		return [...normalized];
	}

	export function toProviderInfo(
		providerId: KnownProviderEnum,
		provider: ModelCatalog.ModelsDevProvider,
	): ProviderInfo {
		return {
			id: providerId,
			name: provider.name,
			env: provider.env,
			key: provider.key,
			options: provider.headers,
		};
	}

	function toModelValue(
		providerId: KnownProviderEnum,
		provider: ModelCatalog.ModelsDevProvider,
		model: ModelCatalog.ModelsDevModel,
	): Info {
		return applyModification(providerId, provider, model);
	}

	export async function getBuiltInModels(): Promise<BuiltInModels> {
		const catalog = await ModelCatalog.get();
		return pipe(
			catalog,
			pick(BUILTINS),
			mapValues((provider, providerId) =>
				mapValues(provider.models, (model) => toModelValue(providerId as KnownProviderEnum, provider, model)),
			),
		) as BuiltInModels;
	}

	export const registry = lazy(async () => {
		const registry: Map<KnownProviderEnum, Map<string, Info>> = new Map();
		const models = await getBuiltInModels();
		for (const [provider, value] of Object.entries(models) as Array<[KnownProviderEnum, Record<string, Info>]>) {
			const providerModels = new Map<string, Info>();
			for (const [id, model] of Object.entries(value)) {
				providerModels.set(id, model);
			}
			registry.set(provider, providerModels);
		}
		return registry;
	});

	export async function getModel<TProvider extends KnownProviderEnum, TModel extends Info["id"]>(
		provider: TProvider,
		model: TModel,
		overrides?: Partial<Info>,
	) {
		const data = await registry();
		const providerModels = data.get(provider);
		const result = providerModels?.get(model);
		if (result && overrides) {
			return { ...result, ...overrides };
		}
		return result;
	}

	export async function getProviders(): Promise<KnownProviderEnum[]> {
		const data = await registry();
		return Array.from(data.keys());
	}

	export async function getModels<TProvider extends KnownProviderEnum>(provider: TProvider): Promise<Info[]> {
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
	export function supportsXhigh(model: Info): boolean {
		return isGpt5OrLater(model.id);
	}

	/**
	 * Check if two models are equal by comparing both their id and provider id.
	 * Returns false if either model is null or undefined.
	 */
	export function modelsAreEqual(a: Info | null | undefined, b: Info | null | undefined): boolean {
		if (!a || !b) return false;
		return a.id === b.id && a.provider.id === b.provider.id;
	}

	//
	// model compat flags mapping based on protocol
	export interface ProtocolCompatFlagMapping {
		[KnownProtocolEnum.anthropicMessages]: ModelFlag.AnthropicMessagesCompat;
		[KnownProtocolEnum.openaiCompletions]: ModelFlag.OpenAICompletionsCompat;
		[KnownProtocolEnum.openaiResponses]: Record<string, never>;
	}

	const COMPAT_FLAG_REGISTRY: {
		[K in keyof ProtocolCompatFlagMapping]: (model: Info) => ProtocolCompatFlagMapping[K];
	} = {
		[KnownProtocolEnum.anthropicMessages]: ModelCompat.handleAnthropicMessages,
		[KnownProtocolEnum.openaiCompletions]: ModelCompat.handleOpenAICompletions,
		[KnownProtocolEnum.openaiResponses]: () => ({}),
	};

	export function resolveCompat<TProtocol extends KnownProtocolEnum>(
		model: TModel<TProtocol>,
	): ProtocolCompatFlagMapping[TProtocol] {
		return COMPAT_FLAG_REGISTRY[model.protocol](model);
	}
}
