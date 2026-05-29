import "./llm/register";

import type { Message } from "./message/message";
import type { Model } from "./model/model";
import { Protocol } from "./llm/protocol";
import type { AssistantMessageEventStream } from "./utils/eventstream";

/**
 * Stream assistant responses for a model and context.
 *
 * Example:
 *
 * ```ts
 * const s = stream(model, context, {
 *   apiKey: process.env.ANTHROPIC_API_KEY,
 * });
 *
 * for await (const event of s) {
 *   if (event.type === "text.delta") {
 *     process.stdout.write(event.delta);
 *   }
 * }
 *
 * const message = await s.result();
 * ```
 *
 * This export also includes convenience helpers:
 *
 * ```ts
 * const message = await stream.complete(model, context, options);
 * ```
 */
type StreamCallable = {
	<TProtocol extends Protocol.ProtocolWithOptions>(
		model: Model.TModel<TProtocol>,
		context: Message.Context,
		options?: Protocol.OptionsFor<TProtocol>,
	): AssistantMessageEventStream;
	complete: typeof Protocol.complete;
	resolveProtocolProvider: typeof Protocol.resolveProtocolProvider;
};

const streamImpl = <TProtocol extends Protocol.ProtocolWithOptions>(
	model: Model.TModel<TProtocol>,
	context: Message.Context,
	options?: Protocol.OptionsFor<TProtocol>,
): AssistantMessageEventStream => Protocol.stream(model, context, options);

/**
 * Start a streaming assistant response for a model/context pair.
 *
 * This is the main streaming entrypoint.
 * Attached helpers:
 *
 * - `stream.complete(...)` resolves the final assistant message without manually iterating events.
 * - `stream.resolveProtocolProvider(...)` exposes protocol resolution for advanced integrations.
 */
export const stream = Object.assign(streamImpl, {
	complete: Protocol.complete,
	resolveProtocolProvider: Protocol.resolveProtocolProvider,
}) as StreamCallable;

/** Resolve a streamed response directly to the final assistant message. */
export const complete = Protocol.complete;
