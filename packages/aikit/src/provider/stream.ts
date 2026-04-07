import { NamedError } from "@codeworksh/utils";
import { type Static, Type } from "@sinclair/typebox";
import type { Message } from "../message/message";
import { Model } from "../model/model";
import type { AssistantMessageEventStream } from "../utils/eventstream";

export namespace Stream {
	export const ProtocolProviderNotFoundError = NamedError.create(
		"ProtocolProviderNotFoundError",
		Type.Object({
			protocol: Model.KnownProtocolSchema,
		}),
	);
	export type ProtocolProviderNotFoundError = InstanceType<typeof ProtocolProviderNotFoundError>;

	export const ProtocolMismatchError = NamedError.create(
		"ProtocolMismatchError",
		Type.Object({
			actual: Model.KnownProtocolSchema,
			expected: Model.KnownProtocolSchema,
		}),
	);
	export type ProtocolMismatchError = InstanceType<typeof ProtocolMismatchError>;

	export const ThinkingLevelEnum = {
		off: "off",
		minimal: "minimal",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
	} as const;
	export const ThinkingLevelSchema = Type.Union([
		Type.Literal(ThinkingLevelEnum.off),
		Type.Literal(ThinkingLevelEnum.minimal),
		Type.Literal(ThinkingLevelEnum.low),
		Type.Literal(ThinkingLevelEnum.medium),
		Type.Literal(ThinkingLevelEnum.high),
		Type.Literal(ThinkingLevelEnum.xhigh),
	]);
	export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

	export const ThinkingBudgetsSchema = Type.Object({
		off: Type.Optional(Type.Number()),
		minimal: Type.Optional(Type.Number()),
		low: Type.Optional(Type.Number()),
		medium: Type.Optional(Type.Number()),
		high: Type.Optional(Type.Number()),
	});
	export type ThinkingBudgets = Static<typeof ThinkingBudgetsSchema>;

	export const CacheRetentionSchema = Type.Union([Type.Literal("none"), Type.Literal("short"), Type.Literal("long")]);
	export type CacheRetention = Static<typeof CacheRetentionSchema>;

	export const TransportSchema = Type.Union([Type.Literal("sse"), Type.Literal("websocket"), Type.Literal("auto")]);
	export type Transport = Static<typeof TransportSchema>;

	export const OptionsSchema = Type.Object({
		temperature: Type.Optional(Type.Number()),
		maxTokens: Type.Optional(Type.Number()),
		signal: Type.Optional(Type.Unsafe<AbortSignal>()),
		apiKey: Type.Optional(Type.String()),
		transport: Type.Optional(TransportSchema),
		cacheRetention: Type.Optional(CacheRetentionSchema),
		sessionId: Type.Optional(Type.String()),
		onPayload: Type.Optional(Type.Unsafe<(payload: unknown, model: Model.TModel<Model.KnownProtocol>) => unknown>()),
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		maxRetryDelayMs: Type.Optional(Type.Number()),
		metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	});
	export type Options = Static<typeof OptionsSchema>;
	export type ProviderOptions = Options & Record<string, unknown>;

	export const SimpleOptionsSchema = Type.Composite([
		OptionsSchema,
		Type.Object({
			reasoning: Type.Optional(ThinkingLevelSchema),
			thinkingBudgets: Type.Optional(ThinkingBudgetsSchema),
		}),
	]);
	export type SimpleOptions = Static<typeof SimpleOptionsSchema>;

	// Contract:
	// - Must return an AssistantMessageEventStream.
	// - Once invoked, request/model/runtime failures should be encoded in the
	//   returned stream, not thrown.
	// - Error termination must produce an AssistantMessage with stopReason
	//   "error" or "aborted" and errorMessage, emitted via the stream protocol.
	export type StreamFunction<
		TProtocol extends Model.KnownProtocol = Model.KnownProtocol,
		TOptions extends Options = Options,
	> = (model: Model.TModel<TProtocol>, context: Message.Context, options?: TOptions) => AssistantMessageEventStream;

	export function buildBaseOptions(model: Model.Value, options?: SimpleOptions, apiKey?: string): Options {
		return {
			temperature: options?.temperature,
			maxTokens: options?.maxTokens || Math.min(model.maxTokens, 32000),
			signal: options?.signal,
			apiKey: apiKey || options?.apiKey,
			transport: options?.transport,
			cacheRetention: options?.cacheRetention,
			sessionId: options?.sessionId,
			headers: options?.headers,
			onPayload: options?.onPayload,
			maxRetryDelayMs: options?.maxRetryDelayMs,
			metadata: options?.metadata,
		};
	}

	export function clampReasoning(effort: ThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh"> | undefined {
		return effort === ThinkingLevelEnum.xhigh ? ThinkingLevelEnum.high : effort;
	}

	export function adjustMaxTokensForThinking(
		baseMaxTokens: number,
		modelMaxTokens: number,
		reasoningLevel: ThinkingLevel,
		customBudgets?: ThinkingBudgets,
	): { maxTokens: number; thinkingBudget: number } {
		const defaultBudgets: ThinkingBudgets = {
			minimal: 1024,
			low: 2048,
			medium: 8192,
			high: 16384,
		};
		const budgets = { ...defaultBudgets, ...customBudgets };
		const minOutputTokens = 1024;
		const level = clampReasoning(reasoningLevel)!;
		let thinkingBudget = budgets[level]!;
		const maxTokens = Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

		if (maxTokens <= thinkingBudget) {
			thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
		}

		return { maxTokens, thinkingBudget };
	}

	export type ProtocolStreamFunction = (
		model: Model.Value,
		context: Message.Context,
		options?: Options,
	) => AssistantMessageEventStream;

	export type ProtocolStreamSimpleFunction = (
		model: Model.Value,
		context: Message.Context,
		options?: SimpleOptions,
	) => AssistantMessageEventStream;

	export interface ProtocolProvider<
		TProtocol extends Model.KnownProtocol = Model.KnownProtocol,
		TOptions extends Options = Options,
	> {
		protocol: TProtocol;
		stream: StreamFunction<TProtocol, TOptions>;
		streamSimple: StreamFunction<TProtocol, SimpleOptions>;
	}

	type RegisteredProtocolProvider = {
		provider: ProtocolProvider<Model.KnownProtocol, Options>;
		sourceId?: string;
	};

	const protocolProviderRegistry = new Map<Model.KnownProtocol, RegisteredProtocolProvider>();

	function wrapStream<TProtocol extends Model.KnownProtocol, TOptions extends Options>(
		protocol: TProtocol,
		stream: StreamFunction<TProtocol, TOptions>,
	): ProtocolStreamFunction {
		return (model, context, options) => {
			if (model.protocol !== protocol) {
				throw new ProtocolMismatchError({
					actual: model.protocol,
					expected: protocol,
				});
			}
			return stream(model as Model.TModel<TProtocol>, context, options as TOptions);
		};
	}

	function wrapStreamSimple<TProtocol extends Model.KnownProtocol>(
		protocol: TProtocol,
		streamSimple: StreamFunction<TProtocol, SimpleOptions>,
	): ProtocolStreamSimpleFunction {
		return (model, context, options) => {
			if (model.protocol !== protocol) {
				throw new ProtocolMismatchError({
					actual: model.protocol,
					expected: protocol,
				});
			}
			return streamSimple(model as Model.TModel<TProtocol>, context, options);
		};
	}

	export function registerProtocolProvider<TProtocol extends Model.KnownProtocol, TOptions extends Options>(
		provider: ProtocolProvider<TProtocol, TOptions>,
		sourceId?: string,
	): void {
		protocolProviderRegistry.set(provider.protocol, {
			provider: {
				protocol: provider.protocol,
				stream: wrapStream(provider.protocol, provider.stream),
				streamSimple: wrapStreamSimple(provider.protocol, provider.streamSimple),
			},
			sourceId,
		});
	}

	export function getProtocolProvider(
		protocol: Model.KnownProtocol,
	): ProtocolProvider<Model.KnownProtocol, Options> | undefined {
		return protocolProviderRegistry.get(protocol)?.provider;
	}

	export function resolveProtocolProvider(model: Model.Value): ProtocolProvider<Model.KnownProtocol, Options> {
		const provider = getProtocolProvider(model.protocol);
		if (!provider) {
			throw new ProtocolProviderNotFoundError({
				protocol: model.protocol,
			});
		}
		return provider;
	}

	export function stream(
		model: Model.Value,
		context: Message.Context,
		options?: Options,
	): AssistantMessageEventStream {
		const provider = resolveProtocolProvider(model);
		return provider.stream(model, context, options);
	}

	export async function complete(
		model: Model.Value,
		context: Message.Context,
		options?: Options,
	): Promise<Message.AssistantMessage> {
		const s = stream(model, context, options);
		return s.result();
	}

	export function streamSimple(
		model: Model.Value,
		context: Message.Context,
		options?: SimpleOptions,
	): AssistantMessageEventStream {
		const provider = resolveProtocolProvider(model);
		return provider.streamSimple(model, context, options);
	}

	export async function completeSimple(
		model: Model.Value,
		context: Message.Context,
		options?: SimpleOptions,
	): Promise<Message.AssistantMessage> {
		const s = streamSimple(model, context, options);
		return s.result();
	}

	export function getApiProviders(): ProtocolProvider<Model.KnownProtocol, Options>[] {
		return Array.from(protocolProviderRegistry.values(), (entry) => entry.provider);
	}

	export function unregisterProtocolProviders(sourceId: string): void {
		for (const [api, entry] of protocolProviderRegistry.entries()) {
			if (entry.sourceId === sourceId) {
				protocolProviderRegistry.delete(api);
			}
		}
	}

	export function clearProtocolProviders(): void {
		protocolProviderRegistry.clear();
	}
}
