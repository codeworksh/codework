import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam, MessageCreateParamsStreaming, MessageParam } from "@anthropic-ai/sdk/resources";
import Type, { type Static } from "typebox";
import { Message } from "../../message/message";
import { Model } from "../../model/model";
import { getEnvApiKey } from "../../provider/providers/utils";
import { AssistantMessageEventStream } from "../../utils/eventstream";
import { parseStreamingJson } from "../../utils/jsonparse";
import { sanitizeSurrogates } from "../../utils/sanitize";
import * as Known from "../known";
import * as Protocol from "../protocol";
import { ProtocolAuthError } from "../schema/errors";
import { CacheRetention, GenerationOptions, ThinkingBudgetsSchema, ThinkingLevelSchema } from "../schema/options";
import { createObjectSchemaBuilder } from "../schema/utils";
import { adjustMaxTokensForThinking, mergeHeaders } from "./shared";

export const PROTOCOL = Known.KnownProtocolEnum.anthropicMessages;

// =============================================================================
// Request Body Schema
// =============================================================================
export const CacheControl = Type.Object({
	type: Type.Union([Type.Literal("ephemeral")]),
	ttl: Type.Optional(Type.Union([Type.Literal("5m"), Type.Literal("1h")])),
});
export type CacheControl = Static<typeof CacheControl>;

export const AnthropicToolChoiceSchema = Type.Union([
	Type.Object({
		type: Type.Literal("auto"),
		// disable_parallel_tool_use
		disableParallelToolUse: Type.Optional(Type.Boolean()),
	}),
	Type.Object({
		type: Type.Literal("any"),
		// disable_parallel_tool_use
		disableParallelToolUse: Type.Optional(Type.Boolean()),
	}),
	Type.Object({
		type: Type.Literal("tool"),
		name: Type.String(),
		// disable_parallel_tool_use
		disableParallelToolUse: Type.Optional(Type.Boolean()),
	}),
	Type.Object({
		type: Type.Literal("none"),
	}),
]);

// =============================================================================
// Input Options Schema
// =============================================================================
const AnthropicOptionsSchema = createObjectSchemaBuilder(GenerationOptions)
	.withOption("model", Type.String())
	.withOptions({
		cacheRetention: Type.Optional(CacheRetention),
		cacheControl: Type.Optional(CacheControl),
		thinkingEnabled: Type.Optional(Type.Boolean()),
		thinkingBudgetTokens: Type.Optional(Type.Number()),
		toolChoice: Type.Optional(AnthropicToolChoiceSchema),
		apiKey: Type.Optional(Type.String()),
	})
	.withOption("client", Type.Optional(Type.Unsafe<InstanceType<typeof Anthropic>>({})))
	.popOption("presencePenalty")
	.popOption("frequencyPenalty")
	.popOption("seed")
	.make();
export type AnthropicOptions = Static<typeof AnthropicOptionsSchema>;

const AnthropicOptionsWithThinkingSchema = createObjectSchemaBuilder(AnthropicOptionsSchema)
	.withOption("reasoning", ThinkingLevelSchema)
	.withOption("thinkingEnabled", Type.Boolean())
	.withOption("thinkingBudgets", ThinkingBudgetsSchema)
	.withOption("thinkingBudgetTokens", Type.Number())
	.make();
export type AnthropicOptionsWithThinking = Static<typeof AnthropicOptionsWithThinkingSchema>;

function createClient(
	model: Model.TModel<typeof Model.KnownProtocolEnum.anthropicMessages>,
	apiKey: string,
	optionsHeaders?: Record<string, string>,
): { client: Anthropic; isOAuthToken: boolean } {
	const betaFeatures: string[] = ["fine-grained-tool-streaming-2025-05-14"];
	const defaultHeaders = mergeHeaders(
		{
			accept: "application/json",
			"anthropic-dangerous-direct-browser-access": "true",
			"anthropic-beta": betaFeatures.join(","),
		},
		model.headers,
		optionsHeaders,
	);

	return {
		client: new Anthropic({
			apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders,
		}),
		isOAuthToken: false,
	};
}

function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (typeof process !== "undefined" && process.env.CODEWORK_CACHE_RETENTION === "long") {
		return "long";
	}
	return "short";
}

function getCacheControl(baseUrl: string, cache?: CacheRetention): CacheControl | undefined {
	const retention = resolveCacheRetention(cache);
	if (retention === "none") return;

	const ttl = retention === "long" && baseUrl.includes("api.anthropic.com") ? "1h" : undefined;
	return { ttl, type: "ephemeral" };
}

function convertContentBlocks(content: (Message.TextContent | Message.ImageContent)[]):
	| string
	| Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((c) => (c as Message.TextContent).text).join("\n"));
	}

	const blocks = content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: sanitizeSurrogates(block.text),
			};
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
				data: block.data,
			},
		};
	});

	if (!blocks.some((b) => b.type === "text")) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

function buildSyntheticToolResult(
	block: Extract<Message.ToolCall, { status: "pending" | "running" }>,
): ContentBlockParam {
	return {
		type: "tool_result",
		tool_use_id: block.callID,
		content: convertContentBlocks([
			{
				type: "text",
				text: ["<result>", "No Result Provided", "</result>"].join("\n"),
			},
		]),
		is_error: true,
	};
}

function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function assertReplayableAssistant(message: Message.AssistantMessage): void {
	let sawToolCall = false;
	let sawNonTerminalToolCall = false;
	let sawTerminalToolCall = false;

	for (const part of message.parts) {
		if (part.type === "image") {
			throw new Error("Anthropic replay does not support assistant image parts");
		}

		if (part.type === "toolCall") {
			sawToolCall = true;
			if (part.status === "pending" || part.status === "running") {
				sawNonTerminalToolCall = true;
			} else {
				sawTerminalToolCall = true;
			}
			continue;
		}

		if (sawToolCall) {
			throw new Error("Assistant parts after a toolCall are not replayable for Anthropic");
		}
	}

	if (sawToolCall && message.stopReason !== "toolUse") {
		throw new Error("Assistant message with tool calls must have stopReason 'toolUse'");
	}

	if (!sawToolCall && message.stopReason === "toolUse") {
		throw new Error("Assistant message with stopReason 'toolUse' must contain at least one toolCall");
	}

	if (sawTerminalToolCall && sawNonTerminalToolCall) {
		throw new Error("Assistant message cannot mix terminal and non-terminal toolCall states");
	}
}

function convertMessages(
	messages: Message.Message[],
	model: Model.TModel<typeof Model.KnownProtocolEnum.anthropicMessages>,
	cacheControl?: CacheControl,
): MessageParam[] {
	const params: MessageParam[] = [];
	const transformedMessages = Message.transformMessages(messages, model, normalizeToolCallId);

	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			const blocks: ContentBlockParam[] = msg.parts.map((item) => {
				if (item.type === "text") {
					return {
						type: "text",
						text: sanitizeSurrogates(item.text),
					};
				}
				return {
					type: "image",
					source: {
						type: "base64",
						media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
						data: item.data,
					},
				};
			});
			let filteredBlocks = !model.input.includes("image") ? blocks.filter((b) => b.type !== "image") : blocks;
			filteredBlocks = filteredBlocks.filter((b) => (b.type === "text" ? b.text.trim().length > 0 : true));
			if (filteredBlocks.length === 0) continue;
			params.push({
				role: "user",
				content: filteredBlocks,
			});
			continue;
		}

		if (msg.stopReason === "error" || msg.stopReason === "aborted") {
			continue;
		}

		assertReplayableAssistant(msg);

		const assistantBlocks: ContentBlockParam[] = [];
		const toolResults: ContentBlockParam[] = [];

		for (const block of msg.parts) {
			if (block.type === "text") {
				if (block.text.trim().length === 0) continue;
				assistantBlocks.push({
					type: "text",
					text: sanitizeSurrogates(block.text),
				});
			} else if (block.type === "thinking") {
				if (block.thinking.trim().length === 0) continue;
				if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
					assistantBlocks.push({
						type: "text",
						text: sanitizeSurrogates(block.thinking),
					});
				} else {
					assistantBlocks.push({
						type: "thinking",
						thinking: sanitizeSurrogates(block.thinking),
						signature: block.thinkingSignature,
					});
				}
			} else if (block.type === "toolCall") {
				assistantBlocks.push({
					type: "tool_use",
					id: block.callID,
					name: block.name,
					input: block.arguments ?? {},
				});

				if (block.status === "pending" || block.status === "running") {
					toolResults.push(buildSyntheticToolResult(block));
				} else {
					toolResults.push({
						type: "tool_result",
						tool_use_id: block.callID,
						content: convertContentBlocks(block.result.content),
						is_error: block.result.isError,
					});
				}
			}
		}

		if (assistantBlocks.length > 0) {
			params.push({
				role: "assistant",
				content: assistantBlocks,
			});
		}

		if (toolResults.length > 0) {
			params.push({
				role: "user",
				content: toolResults,
			});
		}
	}

	if (cacheControl && params.length > 0) {
		const lastMessage = params[params.length - 1]!;
		if (lastMessage.role === "user") {
			if (Array.isArray(lastMessage.content)) {
				const lastBlock = lastMessage.content[lastMessage.content.length - 1];
				if (
					lastBlock &&
					(lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")
				) {
					(lastBlock as { cache_control?: { type: "ephemeral"; ttl?: "1h" } }).cache_control = cacheControl as {
						type: "ephemeral";
						ttl?: "1h";
					};
				}
			} else if (typeof lastMessage.content === "string") {
				lastMessage.content = [
					{
						type: "text",
						text: lastMessage.content,
						cache_control: cacheControl,
					},
				] as any;
			}
		}
	}

	return params;
}

function convertTools(tools: Message.Tool[]): Anthropic.Messages.Tool[] {
	if (!tools) return [];

	return tools.map((tool) => {
		const jsonSchema = tool.parameters as any; // TypeBox already generates JSON Schema

		return {
			name: tool.name,
			description: tool.description,
			input_schema: {
				type: "object" as const,
				properties: jsonSchema.properties || {},
				required: jsonSchema.required || [],
			},
		};
	});
}

type AnthropicStopReason = Anthropic.Messages.StopReason | "sensitive";

function mapStopReason(reason: AnthropicStopReason): Message.StopReason {
	switch (reason) {
		case "end_turn":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		case "pause_turn":
		case "stop_sequence":
			return "stop";
		case "refusal":
		case "sensitive":
			return "error";
		default:
			throw new Error("Unhandled Anthropic stop reason");
	}
}

function buildParams(
	model: Model.TModel<typeof Model.KnownProtocolEnum.anthropicMessages>,
	context: Message.Context,
	options?: AnthropicOptions | AnthropicOptionsWithThinking,
): MessageCreateParamsStreaming {
	// configure cache, prioritise cacheControl otherwise cacheRetention property
	const cacheControl = options?.cacheControl ?? getCacheControl(model.baseUrl, options?.cacheRetention);

	// build request params
	const params: MessageCreateParamsStreaming = {
		model: model.id,
		messages: convertMessages(context.messages, model, cacheControl),
		max_tokens: options?.maxTokens || (model.maxTokens / 3) | 0,
		stream: true, // we always stream
	};

	if (context.systemPrompt) {
		params.system = [
			{
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
	}

	if (options?.temperature !== undefined && !options?.thinkingEnabled) {
		params.temperature = options.temperature;
	}

	if (context.tools) {
		params.tools = convertTools(context.tools);
	}

	// is thinking enabled; has model has reasoning
	if (options?.thinkingEnabled && model.reasoning) {
		params.thinking = {
			type: "enabled",
			budget_tokens: options?.thinkingBudgetTokens || 1024,
		};
	}

	if (options?.metadata) {
		const userId = options.metadata.user_id || options.metadata.userId;
		if (typeof userId === "string") {
			params.metadata = { user_id: userId };
		}
	}

	if (options?.toolChoice) {
		params.tool_choice = typeof options.toolChoice === "string" ? { type: options.toolChoice } : options.toolChoice;
	}

	return params;
}

type Block = (Message.ThinkingContent | Message.TextContent | (Message.ToolCall & { partialJson: string })) & {
	index: number;
};

// =============================================================================
// Stream Functions
// =============================================================================
export const stream: Protocol.StreamFunction<
	typeof Known.KnownProtocolEnum.anthropicMessages,
	typeof AnthropicOptionsSchema
> = (model, context, options) => {
	const stream = new AssistantMessageEventStream();

	void (async () => {
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
			//
			// use or build client
			let client: Anthropic;
			if (options?.client) {
				client = options.client;
			} else {
				const apiKey = options?.apiKey ?? getEnvApiKey(model.provider);
				if (!apiKey) {
					throw new ProtocolAuthError({
						protocol: PROTOCOL,
						message: "protocol auth error; apiKey or auth must be provided",
					});
				}
				const created = createClient(model, apiKey, options?.headers);
				client = created.client;
			}

			//
			// build params for the request
			let params = buildParams(model, context, options);
			const mutParams = await options?.onPayload?.(params, model);
			if (mutParams !== undefined) {
				params = mutParams as MessageCreateParamsStreaming;
			}

			const anthropicStream = client.messages.stream({ ...params, stream: true }, { signal: options?.signal });
			stream.push({ type: "start", partial: output });

			// mutates
			const blocks = output.parts as Block[];

			for await (const event of anthropicStream) {
				if (event.type === "message_start") {
					output.responseId = event.message.id;
					// Capture initial token usage from message_start event
					// This ensures we have input token counts even if the stream is aborted early
					output.usage.input = event.message.usage.input_tokens || 0;
					output.usage.output = event.message.usage.output_tokens || 0;
					output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
					output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
					// Anthropic doesn't provide total_tokens, compute from components
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					Model.calculateCost(model, output.usage);
				} else if (event.type === "content_block_start") {
					if (event.content_block.type === "text") {
						const block: Block = { type: "text", text: "", index: event.index };
						output.parts.push(block); // push the block to parts
						// `contentIndex` points to the index of the block within parts
						// Useful for replaying message and corresponding parts based on stream.
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
					// *_delta updates existing block part
					// filtered based on event identifier `event.index` (not to confuse with array indices)
					// index persisted on block(part) with `index`
					const partIndex = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[partIndex];
					if (!block) continue; // block doesn't exist for delta, move on

					if (event.delta.type === "text_delta" && block.type === "text") {
						block.text += event.delta.text; // mutates block, implicitly mutating block in output.parts
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
						delete (block as any).index; // clear block index; used for internal loop state
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
							delete (block as any).partialJson; // clear partialJson; used for internal loop state
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
					// Only update usage fields if present (not null).
					// Preserves input_tokens from message_start when proxies omit it in message_delta.
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
					// Anthropic doesn't provide total_tokens, compute from components
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					Model.calculateCost(model, output.usage);
				}
			}

			if (options?.signal?.aborted) {
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
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamWithThinking: Protocol.StreamFunction<
	typeof Known.KnownProtocolEnum.anthropicMessages,
	typeof AnthropicOptionsWithThinkingSchema
> = (model, context, options) => {
	const overrides = { ...options, maxTokens: options?.maxTokens ?? Math.min(model.maxTokens, 32000) };
	if (!options?.reasoning) {
		return stream(model, context, { ...overrides, thinkingEnabled: false });
	}
	const adjusted = adjustMaxTokensForThinking(
		overrides.maxTokens || 0,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);

	return stream(model, context, {
		...overrides,
		maxTokens: adjusted.maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: adjusted.thinkingBudget,
	});
};

const protocol: Protocol.Protocol<
	typeof Known.KnownProtocolEnum.anthropicMessages,
	typeof AnthropicOptionsSchema,
	typeof AnthropicOptionsWithThinkingSchema
> = {
	protocol: PROTOCOL,
	schema: AnthropicOptionsSchema,
	schemaWithThinking: AnthropicOptionsWithThinkingSchema,
	stream: stream,
	streamSimple: streamWithThinking,
};

export default protocol;
