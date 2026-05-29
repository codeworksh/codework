import { NamedError } from "@codeworksh/utils";
import type { Static, TSchema } from "typebox";
import Type from "typebox";
import type { Message } from "../message/message";
import { Model } from "../model/model";
import type { AssistantMessageEventStream } from "../utils/eventstream";
import type { SharedOptions, ThinkingBudgets } from "./shared";

export namespace Protocol {
	export const ProviderProtocolNotFoundError = NamedError.create(
		"ProviderProtocolNotFoundError",
		Type.Object({
			protocol: Model.KnownProviderEnumSchema,
		}),
	);
	export type ProviderProtocolNotFoundError = InstanceType<typeof ProviderProtocolNotFoundError>;

	export const ProtocolMismatchError = NamedError.create(
		"ProtocolMismatchError",
		Type.Object({
			actual: Model.KnownProviderEnumSchema,
			expected: Model.KnownProviderEnumSchema,
		}),
	);
	export type ProtocolMismatchError = InstanceType<typeof ProtocolMismatchError>;

	export const ProtocolAuthError = NamedError.create(
		"ProtocolAuthError",
		Type.Object({
			message: Type.String(),
			protocol: Type.String(),
		}),
	);
	export type ProtocolAuthError = InstanceType<typeof ProtocolAuthError>;

	export type CommonOptions = SharedOptions & {
		reasoning?: Model.ActiveThinkingLevel;
		thinkingBudgets?: ThinkingBudgets;
	};
	export interface OptionsByProtocol {}
	export type ProtocolWithOptions = keyof OptionsByProtocol & Model.KnownProviderEnum;
	export type OptionsFor<TProtocol extends ProtocolWithOptions> = OptionsByProtocol[TProtocol];

	export type StreamFunction<
		TProtocol extends Model.KnownProviderEnum = Model.KnownProviderEnum,
		S extends TSchema = TSchema,
	> = (model: Model.TModel<TProtocol>, context: Message.Context, options?: Static<S>) => AssistantMessageEventStream;

	export type ProtocolStreamFunction<S extends TSchema = TSchema> = (
		model: Model.Info,
		context: Message.Context,
		options?: Static<S>,
	) => AssistantMessageEventStream;

	export interface Protocol<
		TProtocol extends Model.KnownProviderEnum = Model.KnownProviderEnum,
		S extends TSchema = TSchema,
	> {
		protocol: TProtocol;
		stream: StreamFunction<TProtocol, S>;
	}

	export interface RegisteredProtocol<
		TProtocol extends Model.KnownProviderEnum = Model.KnownProviderEnum,
		S extends TSchema = TSchema,
	> {
		protocol: TProtocol;
		stream: ProtocolStreamFunction<S>;
	}

	type AnyRegisteredProtocol = RegisteredProtocol<Model.KnownProviderEnum, TSchema>;

	type RegistryEntry = {
		provider: AnyRegisteredProtocol;
		sourceId?: string;
	};

	const protocolRegistry = new Map<Model.KnownProviderEnum, RegistryEntry>();

	function wrapStream<TProtocol extends Model.KnownProviderEnum, S extends TSchema = TSchema>(
		protocol: TProtocol,
		stream: StreamFunction<TProtocol, S>,
	): ProtocolStreamFunction<S> {
		return (model, context, options) => {
			if (model.protocol !== protocol) {
				throw new ProtocolMismatchError({
					actual: model.protocol,
					expected: protocol,
				});
			}

			return stream(model as Model.TModel<TProtocol>, context, options);
		};
	}

	export function registerProtocolProvider<TProtocol extends Model.KnownProviderEnum, S extends TSchema = TSchema>(
		provider: Protocol<TProtocol, S>,
		sourceId?: string,
	): void {
		const registered: RegisteredProtocol<TProtocol, S> = {
			protocol: provider.protocol,
			stream: wrapStream(provider.protocol, provider.stream),
		};

		protocolRegistry.set(provider.protocol, {
			provider: registered as AnyRegisteredProtocol,
			sourceId,
		});
	}

	export function getProtocolProvider(protocol: Model.KnownProviderEnum): AnyRegisteredProtocol | undefined {
		return protocolRegistry.get(protocol)?.provider;
	}

	export function resolveProtocolProvider(model: Model.Info): AnyRegisteredProtocol {
		const provider = getProtocolProvider(model.protocol);
		if (!provider) {
			throw new ProviderProtocolNotFoundError({
				protocol: model.protocol,
			});
		}

		return provider;
	}

	export function getProtocolProviders(): AnyRegisteredProtocol[] {
		return Array.from(protocolRegistry.values(), (entry) => entry.provider);
	}

	export function stream<TProtocol extends ProtocolWithOptions>(
		model: Model.TModel<TProtocol>,
		context: Message.Context,
		options?: OptionsFor<TProtocol>,
	): AssistantMessageEventStream {
		const provider = resolveProtocolProvider(model);
		return provider.stream(model, context, options);
	}

	export async function complete<TProtocol extends ProtocolWithOptions>(
		model: Model.TModel<TProtocol>,
		context: Message.Context,
		options?: OptionsFor<TProtocol>,
	): Promise<Message.AssistantMessage> {
		const s = stream(model, context, options);
		return s.result();
	}

	export function unregisterProtocolProviders(sourceId: string): void {
		for (const [protocol, entry] of protocolRegistry.entries()) {
			if (entry.sourceId === sourceId) {
				protocolRegistry.delete(protocol);
			}
		}
	}

	export function clearProtocolProviders(): void {
		protocolRegistry.clear();
	}
}
