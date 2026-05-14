import { NamedError } from "@codeworksh/utils";
import type { Static, TSchema } from "typebox";
import Type from "typebox";
import type { Message } from "../message/message";
import { Model } from "../model/model";
import type { AssistantMessageEventStream } from "../utils/eventstream";

export namespace Protocol {
	export const ProviderProtocolNotFoundError = NamedError.create(
		"ProviderProtocolNotFoundError",
		Type.Object({
			protocol: Model.KnownProtocolEnumSchema,
		}),
	);
	export type ProviderProtocolNotFoundError = InstanceType<typeof ProviderProtocolNotFoundError>;

	export const ProtocolMismatchError = NamedError.create(
		"ProtocolMismatchError",
		Type.Object({
			actual: Model.KnownProtocolEnumSchema,
			expected: Model.KnownProtocolEnumSchema,
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

	// Contract:
	// - Must return an AssistantMessageEventStream.
	// - Once invoked, request/model/runtime failures should be encoded in the
	//   returned stream, not thrown.
	// - Error termination must produce an AssistantMessage with stopReason
	//   "error" or "aborted" and errorMessage, emitted via the stream protocol.
	export type StreamFunction<
		TProtocol extends Model.KnownProtocolEnum = Model.KnownProtocolEnum,
		S extends TSchema = TSchema,
	> = (model: Model.TModel<TProtocol>, context: Message.Context, options?: Static<S>) => AssistantMessageEventStream;

	export type ProtocolStreamFunction<S extends TSchema = TSchema> = (
		model: Model.Info,
		context: Message.Context,
		options?: Static<S>,
	) => AssistantMessageEventStream;

	export type ProtocolStreamThinkingFunction<SThinking extends TSchema = TSchema> = (
		model: Model.Info,
		context: Message.Context,
		options?: Static<SThinking>,
	) => AssistantMessageEventStream;

	export interface Protocol<
		TProtocol extends Model.KnownProtocolEnum = Model.KnownProtocolEnum,
		S extends TSchema = TSchema,
		SThinking extends TSchema = TSchema,
	> {
		protocol: TProtocol;
		stream: StreamFunction<TProtocol, S>;
		streamSimple: StreamFunction<TProtocol, SThinking>;
	}

	export interface RegisteredProtocol<
		TProtocol extends Model.KnownProtocolEnum = Model.KnownProtocolEnum,
		S extends TSchema = TSchema,
		SThinking extends TSchema = TSchema,
	> {
		protocol: TProtocol;
		stream: ProtocolStreamFunction<S>;
		streamSimple: ProtocolStreamThinkingFunction<SThinking>;
	}

	type AnyRegisteredProtocol = RegisteredProtocol<Model.KnownProtocolEnum, TSchema, TSchema>;

	type RegistryEntry = {
		provider: AnyRegisteredProtocol;
		sourceId?: string;
	};

	const protocolRegistry = new Map<Model.KnownProtocolEnum, RegistryEntry>();

	function wrapStream<TProtocol extends Model.KnownProtocolEnum, S extends TSchema = TSchema>(
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

	function wrapStreamThinking<TProtocol extends Model.KnownProtocolEnum, SThinking extends TSchema = TSchema>(
		protocol: TProtocol,
		stream: StreamFunction<TProtocol, SThinking>,
	): ProtocolStreamThinkingFunction<SThinking> {
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

	export function registerProtocolProvider<
		TProtocol extends Model.KnownProtocolEnum,
		S extends TSchema = TSchema,
		SThinking extends TSchema = TSchema,
	>(provider: Protocol<TProtocol, S, SThinking>, sourceId?: string): void {
		const registered: RegisteredProtocol<TProtocol, S, SThinking> = {
			protocol: provider.protocol,
			stream: wrapStream(provider.protocol, provider.stream),
			streamSimple: wrapStreamThinking(provider.protocol, provider.streamSimple),
		};

		protocolRegistry.set(provider.protocol, {
			provider: registered as AnyRegisteredProtocol,
			sourceId,
		});
	}

	export function getProtocolProvider(protocol: Model.KnownProtocolEnum): AnyRegisteredProtocol | undefined {
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
