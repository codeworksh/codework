import "./provider/register";

import type { Message } from "./message/message";
import type { Model } from "./model/model";
import { Stream } from "./provider/stream";
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
 *   if (event.type === "text_delta") {
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
 * const simple = stream.simple(model, context, options);
 * const simpleMessage = await stream.completeSimple(model, context, options);
 * ```
 */
type StreamCallable = {
	(model: Model.Value, context: Message.Context, options?: Stream.Options): AssistantMessageEventStream;
	complete: typeof Stream.complete;
	simple: typeof Stream.streamSimple;
	completeSimple: typeof Stream.completeSimple;
	resolveProtocolProvider: typeof Stream.resolveProtocolProvider;
};

const streamImpl = (
	model: Model.Value,
	context: Message.Context,
	options?: Stream.Options,
): AssistantMessageEventStream => Stream.stream(model, context, options);

/**
 * Start a streaming assistant response for a model/context pair.
 *
 * This is the main streaming entrypoint.
 * Attached helpers:
 *
 * - `stream.complete(...)` resolves the final assistant message without manually iterating events.
 * - `stream.simple(...)` uses `Stream.SimpleOptions` for higher-level reasoning controls.
 * - `stream.completeSimple(...)` is the non-streaming counterpart to `stream.simple(...)`.
 * - `stream.resolveProtocolProvider(...)` exposes protocol resolution for advanced integrations.
 */
export const stream = Object.assign(streamImpl, {
	complete: Stream.complete,
	simple: Stream.streamSimple,
	completeSimple: Stream.completeSimple,
	resolveProtocolProvider: Stream.resolveProtocolProvider,
}) as StreamCallable;

/** Resolve a streamed response directly to the final assistant message. */
export const complete = Stream.complete;
/** Start a stream using the simplified options surface. */
export const streamSimple = Stream.streamSimple;
/** Resolve a simplified stream request directly to the final assistant message. */
export const completeSimple = Stream.completeSimple;
