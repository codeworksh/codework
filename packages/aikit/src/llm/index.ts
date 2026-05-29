import { Model } from "../model/model";
import { Options } from "./options";
import { Protocol } from "./protocol";
import { stream } from "./stream";

export { Options } from "./options";
export * from "./registry";
export { stream } from "./stream";
export * from "./transform";

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
	Protocol.registerProtocolProvider(createAISDKProtocol(Model.KnownProviderEnum.openrouter));
	Protocol.registerProtocolProvider(createAISDKProtocol(Model.KnownProviderEnum.xai));
}
