import * as Model from "../model/model.ts";
import { Options } from "./options.ts";
import * as Protocol from "./protocol.ts";
import { stream } from "./stream.ts";

export { Options } from "./options.ts";
export * from "./registry.ts";
export { stream } from "./stream.ts";
export * from "./transform.ts";

export function createAISDKProtocol(
	protocol: Model.KnownProviderEnum,
): Protocol.Protocol<Model.KnownProviderEnum, typeof Options> {
	return {
		protocol,
		stream,
	};
}

export function registerAISDKProtocols(): void {
	Protocol.registerProtocolProvider(createAISDKProtocol(Model.KnownProviderEnum.anthropic));
	Protocol.registerProtocolProvider(createAISDKProtocol(Model.KnownProviderEnum.google));
	Protocol.registerProtocolProvider(createAISDKProtocol(Model.KnownProviderEnum.googleVertex));
	Protocol.registerProtocolProvider(createAISDKProtocol(Model.KnownProviderEnum.googleVertexAnthropic));
	Protocol.registerProtocolProvider(createAISDKProtocol(Model.KnownProviderEnum.openai));
	Protocol.registerProtocolProvider(createAISDKProtocol(Model.KnownProviderEnum.openaiCompatible));
	Protocol.registerProtocolProvider(createAISDKProtocol(Model.KnownProviderEnum.openaiCodex));
	Protocol.registerProtocolProvider(createAISDKProtocol(Model.KnownProviderEnum.openrouter));
	Protocol.registerProtocolProvider(createAISDKProtocol(Model.KnownProviderEnum.xai));
}
