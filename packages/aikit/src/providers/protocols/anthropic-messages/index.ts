import { Model } from "../../../model/model";
import { Protocol } from "../../protocol";
import { Options, OptionsWithThinking, PROTOCOL } from "./options";
import { stream, streamWithThinking } from "./stream";

export { createClient } from "./client";
export { mapStopReason } from "./events";
export type { AnthropicStopReason, Block } from "./events";
export { CacheControl, Options, OptionsWithThinking, PROTOCOL } from "./options";
export type {
	CacheControl as CacheControlType,
	Options as AnthropicMessagesOptions,
	OptionsWithThinking as AnthropicMessagesOptionsWithThinking,
} from "./options";
export { buildParams, buildThinkingParams } from "./params";
export type { BuildParams } from "./params";
export { createAnthropicMessagesStream, stream, streamWithThinking } from "./stream";
export type { AnthropicMessagesCreateClient, AnthropicMessagesStreamConfig } from "./stream";
export { convertMessages, convertTools, getCacheControl } from "./transform";

const protocol: Protocol.Protocol<
	typeof Model.KnownProtocolEnum.anthropicMessages,
	typeof Options,
	typeof OptionsWithThinking
> = {
	protocol: PROTOCOL,
	stream: stream,
	streamSimple: streamWithThinking,
};

export default protocol;
