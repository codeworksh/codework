import type Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources";
import type { Static, TSchema } from "typebox";
import { Message } from "../../../message/message";
import { Model } from "../../../model/model";
import { AssistantMessageEventStream } from "../../../utils/eventstream";
import { parseStreamingJson } from "../../../utils/jsonparse";
import { getEnvApiKey } from "../../runtime/env";
import { Protocol } from "../../protocol";
import { createClient as createDefaultClient } from "./client";
import { type Block, mapStopReason } from "./events";
import { Options, OptionsWithThinking, PROTOCOL } from "./options";
import { buildParams, buildThinkingParams, type BuildParams } from "./params";

export type AnthropicMessagesCreateClient<
	TProtocol extends Model.KnownProtocolEnum = typeof Model.KnownProtocolEnum.anthropicMessages,
	S extends TSchema = TSchema,
> = (model: Model.TModel<TProtocol>, apiKey: string, options: Static<S>) => { client: Anthropic };

export type AnthropicMessagesStreamConfig<
	TProtocol extends Model.KnownProtocolEnum = typeof Model.KnownProtocolEnum.anthropicMessages,
	S extends TSchema = TSchema,
> = {
	protocol: TProtocol;
	buildParams: BuildParams<TProtocol, S>;
	createClient?: AnthropicMessagesCreateClient<TProtocol, S>;
};

export function createAnthropicMessagesStream<TProtocol extends Model.KnownProtocolEnum, S extends TSchema>(
	config: AnthropicMessagesStreamConfig<TProtocol, S>,
): Protocol.StreamFunction<TProtocol, S> {
	return (model, context, options) => {
		const stream = new AssistantMessageEventStream();

		void (async () => {
			const runtimeOptions = options as Static<S> & Options;
			const output = Message.createAssistantMessage({
				role: "assistant",
				parts: [],
				protocol: model.protocol,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				time: {
					created: Date.now(),
					completed: Date.now(),
				},
			});

			try {
				let client: Anthropic;
				if (runtimeOptions.client) {
					client = runtimeOptions.client;
				} else {
					const apiKey = runtimeOptions.apiKey ?? getEnvApiKey(model.provider);
					if (!apiKey) {
						throw new Protocol.ProtocolAuthError({
							protocol: config.protocol,
							message: "protocol auth error; apiKey or auth must be provided",
						});
					}

					const created = config.createClient
						? config.createClient(model, apiKey, options)
						: createDefaultClient(model, apiKey, runtimeOptions.headers);
					client = created.client;
				}

				let params = config.buildParams(model, context, options);
				const mutParams = await runtimeOptions.onPayload?.(params, model);
				if (mutParams !== undefined) {
					params = mutParams as MessageCreateParamsStreaming;
				}

				const anthropicStream = client.messages.stream(
					{ ...params, stream: true },
					{ signal: runtimeOptions.signal },
				);
				stream.push({ type: "start", partial: output });

				const blocks = output.parts as Block[];

				for await (const event of anthropicStream) {
					if (event.type === "message_start") {
						output.responseId = event.message.id;
						output.usage.input = event.message.usage.input_tokens || 0;
						output.usage.output = event.message.usage.output_tokens || 0;
						output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
						output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
						output.usage.totalTokens =
							output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
						Model.calculateCost(model, output.usage);
					} else if (event.type === "content_block_start") {
						if (event.content_block.type === "text") {
							const block: Block = { type: "text", text: "", index: event.index };
							output.parts.push(block);
							stream.push({
								type: "text.start",
								partIndex: output.parts.length - 1,
								partial: output,
							});
						} else if (event.content_block.type === "thinking") {
							const block: Block = {
								type: "thinking",
								thinking: "",
								thinkingSignature: "",
								index: event.index,
							};
							output.parts.push(block);
							stream.push({
								type: "thinking.start",
								partIndex: output.parts.length - 1,
								partial: output,
							});
						} else if (event.content_block.type === "redacted_thinking") {
							const block: Block = {
								type: "thinking",
								thinking: "[Reasoning redacted]",
								thinkingSignature: event.content_block.data,
								redacted: true,
								index: event.index,
							};
							output.parts.push(block);
							stream.push({
								type: "thinking.start",
								partIndex: output.parts.length - 1,
								partial: output,
							});
						} else if (event.content_block.type === "tool_use") {
							const block: Block = {
								type: "toolCall",
								callID: event.content_block.id,
								name: event.content_block.name,
								arguments: (event.content_block.input as Record<string, any>) ?? {},
								partialJson: "",
								status: "pending",
								time: {
									start: Date.now(),
									end: Date.now(),
								},
								index: event.index,
							};
							output.parts.push(block);
							stream.push({
								type: "toolcall.start",
								partIndex: output.parts.length - 1,
								partial: output,
							});
						}
					} else if (event.type === "content_block_delta") {
						const partIndex = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[partIndex];
						if (!block) continue;

						if (event.delta.type === "text_delta" && block.type === "text") {
							block.text += event.delta.text;
							stream.push({
								type: "text.delta",
								partIndex: partIndex,
								delta: event.delta.text,
								partial: output,
							});
						} else if (event.delta.type === "thinking_delta" && block.type === "thinking") {
							block.thinking += event.delta.thinking;
							stream.push({
								type: "thinking.delta",
								partIndex: partIndex,
								delta: event.delta.thinking,
								partial: output,
							});
						} else if (event.delta.type === "input_json_delta" && block.type === "toolCall") {
							block.partialJson += event.delta.partial_json;
							block.arguments = parseStreamingJson(block.partialJson);
							stream.push({
								type: "toolcall.delta",
								partIndex: partIndex,
								delta: event.delta.partial_json,
								partial: output,
							});
						} else if (event.delta.type === "signature_delta" && block.type === "thinking") {
							block.thinkingSignature = block.thinkingSignature || "";
							block.thinkingSignature += event.delta.signature;
						}
					} else if (event.type === "content_block_stop") {
						const partIndex = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[partIndex];
						if (block) {
							delete (block as any).index;
							if (block.type === "text") {
								stream.push({
									type: "text.end",
									partIndex: partIndex,
									content: block.text,
									partial: output,
								});
							} else if (block.type === "thinking") {
								stream.push({
									type: "thinking.end",
									partIndex: partIndex,
									content: block.thinking,
									partial: output,
								});
							} else if (block.type === "toolCall") {
								block.arguments = parseStreamingJson(block.partialJson);
								delete (block as any).partialJson;
								stream.push({
									type: "toolcall.end",
									partIndex: partIndex,
									toolCall: block,
									partial: output,
								});
							}
						}
					} else if (event.type === "message_delta") {
						if (event.delta.stop_reason) {
							output.stopReason = mapStopReason(event.delta.stop_reason);
						}
						if (event.usage.input_tokens != null) {
							output.usage.input = event.usage.input_tokens;
						}
						if (event.usage.output_tokens != null) {
							output.usage.output = event.usage.output_tokens;
						}
						if (event.usage.cache_read_input_tokens != null) {
							output.usage.cacheRead = event.usage.cache_read_input_tokens;
						}
						if (event.usage.cache_creation_input_tokens != null) {
							output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
						}
						output.usage.totalTokens =
							output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
						Model.calculateCost(model, output.usage);
					}
				}

				if (runtimeOptions.signal?.aborted) {
					throw new Error("Request was aborted");
				}
				if (output.stopReason === "aborted" || output.stopReason === "error") {
					throw new Error("An unknown error occurred");
				}

				output.time.completed = Date.now();
				stream.push({ type: "done", reason: output.stopReason, message: output });
				stream.end();
			} catch (error) {
				for (const block of output.parts) delete (block as { index?: number }).index;
				output.time.completed = Date.now();
				output.stopReason = runtimeOptions.signal?.aborted ? "aborted" : "error";
				output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);

				const rawMetadata = (error as { error?: { metadata?: { raw?: string } } })?.error?.metadata?.raw;
				if (rawMetadata) output.errorMessage += `\n${rawMetadata}`;

				stream.push({ type: "error", reason: output.stopReason, error: output });
				stream.end();
			}
		})();

		return stream;
	};
}

export const stream: Protocol.StreamFunction<typeof Model.KnownProtocolEnum.anthropicMessages, typeof Options> =
	createAnthropicMessagesStream({ protocol: PROTOCOL, buildParams });

export const streamWithThinking: Protocol.StreamFunction<
	typeof Model.KnownProtocolEnum.anthropicMessages,
	typeof OptionsWithThinking
> = createAnthropicMessagesStream({ protocol: PROTOCOL, buildParams: buildThinkingParams });
