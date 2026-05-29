import { lazy } from "@codeworksh/utils";
import Type, { type Static } from "typebox";
import { ModelCatalog } from "./catalog";

export namespace Model {
	// re-export
	export const KnownProviderEnum = ModelCatalog.KnownProviderEnum;
	export const KnownProviderEnumSchema = ModelCatalog.KnownProviderEnumSchema;
	export type KnownProviderEnum = ModelCatalog.KnownProviderEnum;

	// Common reasoning-effort levels used by adapters that expose model reasoning,
	// thinking, or deliberation controls. Protocol-specific layers can map these
	// values to native fields like OpenAI `reasoning_effort`, Anthropic `thinking`,
	// or Gemini `thinkingConfig`.
	export const ThinkingLevelEnum = {
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

	export const ThinkingLevel = Type.Union([
		Type.Literal(ThinkingLevelEnum.off),
		Type.Literal(ThinkingLevelEnum.minimal),
		Type.Literal(ThinkingLevelEnum.low),
		Type.Literal(ThinkingLevelEnum.medium),
		Type.Literal(ThinkingLevelEnum.high),
		Type.Literal(ThinkingLevelEnum.xhigh),
	]);
	export type ThinkingLevel = Static<typeof ThinkingLevel>;

	export const ActiveThinkingLevel = Type.Union([
		Type.Literal(ThinkingLevelEnum.minimal),
		Type.Literal(ThinkingLevelEnum.low),
		Type.Literal(ThinkingLevelEnum.medium),
		Type.Literal(ThinkingLevelEnum.high),
		Type.Literal(ThinkingLevelEnum.xhigh),
	]);
	export type ActiveThinkingLevel = Static<typeof ActiveThinkingLevel>;

	const ACTIVE_THINKING_LEVELS = [
		ThinkingLevelEnum.minimal,
		ThinkingLevelEnum.low,
		ThinkingLevelEnum.medium,
		ThinkingLevelEnum.high,
		ThinkingLevelEnum.xhigh,
	] as const satisfies readonly ActiveThinkingLevel[];
	const MODEL_THINKING_LEVELS = [
		ThinkingLevelEnum.off,
		...ACTIVE_THINKING_LEVELS,
	] as const satisfies readonly ThinkingLevel[];

	export const ProviderInfo = Type.Object({
		id: Type.String(),
		name: Type.String(),
		source: Type.Enum(["env", "config", "custom", "api", "unknown"]),
		env: Type.Array(Type.String()),
		key: Type.Optional(Type.String()), // runtime api/oauth key
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
			anthropic: KnownProviderEnumSchema,
			google: KnownProviderEnumSchema,
			googleVertex: KnownProviderEnumSchema,
			googleVertexAnthropic: KnownProviderEnumSchema,
			openai: KnownProviderEnumSchema,
			openaiCompatible: KnownProviderEnumSchema,
			openrouter: KnownProviderEnumSchema,
			xai: KnownProviderEnumSchema,
		}),
	);

	export const APIMethodEnum = {
		languageModel: "languageModel",
		chat: "chat",
		completion: "completion",
		completionModel: "completionModel",
		messages: "messages",
		responses: "responses",
	} as const;
	export const APIMethodEnumSchema = Type.Union([
		Type.Literal(APIMethodEnum.languageModel),
		Type.Literal(APIMethodEnum.chat),
		Type.Literal(APIMethodEnum.completion),
		Type.Literal(APIMethodEnum.completionModel),
		Type.Literal(APIMethodEnum.messages),
		Type.Literal(APIMethodEnum.responses),
	]);
	export type APIMethodEnum = Static<typeof APIMethodEnumSchema>;

	export const APIMetadataSchema = Type.Object({
		id: Type.Optional(Type.String()),
		url: Type.Optional(Type.String()),
		method: Type.Optional(APIMethodEnumSchema),
	});
	export type APIMetadata = Static<typeof APIMetadataSchema>;

	export const ThinkingLevelMapSchema = Type.Partial(
		Type.Record(
			ThinkingLevel, // Safe key validation
			Type.Union([Type.String(), Type.Null()]), // Allowed values
		),
	);
	export type ThinkingLevelMap = Static<typeof ThinkingLevelMapSchema>;

	export const Schema = Type.Object({
		id: Type.String(),
		name: Type.String(),
		provider: ProviderInfo,
		baseUrl: Type.String(),
		reasoning: Type.Boolean(),
		thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
		input: InputSchema,
		cost: CostSchema,
		contextWindow: Type.Number(),
		maxTokens: Type.Number(),
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		npm: Type.Optional(Type.String()),
		api: Type.Optional(APIMetadataSchema),
		providerOptionsKey: Type.Optional(Type.String()),
		options: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		providerOptions: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		protocol: KnownProviderEnumSchema, // provider as the underlying protocol
		supportedProtocols: Type.Optional(SupportedProtocolsSchema), // provider as the underlying supported protocols
	});

	export const ExtrasSchema = Type.Object({});

	export const Info = Type.Evaluate(Type.Intersect([Schema, ExtrasSchema]));
	export type Info = Static<typeof Info>;
	export type TModel<TProtocol extends KnownProviderEnum> = Omit<Info, "protocol"> & { protocol: TProtocol };

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

	export type BuiltInModels = Partial<Record<string, Record<string, Info>>>;

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

	export async function getBuiltInModels(): Promise<BuiltInModels> {
		return (await ModelCatalog.get()) as BuiltInModels;
	}

	export const registry = lazy(async () => {
		const registry: Map<string, Map<string, Info>> = new Map();
		const models = await getBuiltInModels();
		for (const [provider, value] of Object.entries(models) as Array<[string, Record<string, Info>]>) {
			const providerModels = new Map<string, Info>();
			for (const [id, model] of Object.entries(value)) {
				providerModels.set(id, model);
			}
			registry.set(provider, providerModels);
		}
		return registry;
	});

	export function supportsProtocol(model: Info, protocol: KnownProviderEnum): boolean {
		if (model.protocol === protocol) return true;
		return Object.values(model.supportedProtocols ?? {}).includes(protocol);
	}

	export async function getModel<TProvider extends string, TModel extends Info["id"]>(
		provider: TProvider,
		model: TModel,
		overrides?: Partial<Info>,
	) {
		const data = await registry();
		const providerModels = data.get(provider);
		const result = providerModels?.get(model);
		if (result && overrides) {
			if (overrides.protocol && !supportsProtocol(result, overrides.protocol)) {
				return undefined;
			}
			return {
				...result,
				...overrides,
			};
		}
		return result;
	}

	export async function getProviders(): Promise<string[]> {
		const data = await registry();
		return Array.from(data.keys());
	}

	export async function getModels<TProvider extends string>(provider: TProvider): Promise<Info[]> {
		const data = await registry();
		const models = data.get(provider);
		return models ? Array.from(models.values()) : [];
	}

	/**
	 * Check if two models are equal by comparing both their id and provider id.
	 * Returns false if either model is null or undefined.
	 */
	export function modelsAreEqual(a: Info | null | undefined, b: Info | null | undefined): boolean {
		if (!a || !b) return false;
		return a.id === b.id && a.provider.id === b.provider.id;
	}

	export function getSupportedThinkingLevels<TProtocol extends KnownProviderEnum>(
		model: TModel<TProtocol>,
	): ThinkingLevel[] {
		if (!model.reasoning) return ["off"];

		return MODEL_THINKING_LEVELS.filter((level) => {
			const mapped = model.thinkingLevelMap?.[level];
			if (mapped === null) return false;
			if (level === "xhigh") return mapped !== undefined;
			return true;
		});
	}

	export function clampThinkingLevel<TProtocol extends KnownProviderEnum>(
		model: TModel<TProtocol>,
		level: ThinkingLevel,
	): ThinkingLevel {
		const availableLevels = getSupportedThinkingLevels(model);
		if (availableLevels.includes(level)) return level;

		const requestedIndex = MODEL_THINKING_LEVELS.indexOf(level);
		if (requestedIndex === -1) return availableLevels[0] ?? "off";

		for (let i = requestedIndex; i < MODEL_THINKING_LEVELS.length; i++) {
			const candidate = MODEL_THINKING_LEVELS[i]!;
			if (availableLevels.includes(candidate)) return candidate;
		}
		for (let i = requestedIndex - 1; i >= 0; i--) {
			const candidate = MODEL_THINKING_LEVELS[i]!;
			if (availableLevels.includes(candidate)) return candidate;
		}
		return availableLevels[0] ?? "off";
	}
}
