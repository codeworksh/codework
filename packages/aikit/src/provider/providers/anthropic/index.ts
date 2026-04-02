import Anthropic from "@anthropic-ai/sdk";
import type {
	ContentBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { Message } from "../../../message/message";
import { Model } from "../../../model/model";
import { AssistantMessageEventStream } from "../../../utils/eventstream";
import { parseStreamingJson } from "../../../utils/jsonparse";
import { sanitizeSurrogates } from "../../../utils/sanitize";
import type { Provider } from "../../provider";
import { Stream } from "../../stream";

export interface AnthropicOptions extends Stream.Options {
	thinkingEnabled?: boolean;
	thinkingBudgetTokens?: number;
	interleavedThinking?: boolean;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	client?: Anthropic;
}

function getEnvApiKey(_provider: Provider.Info): string | undefined {
	return undefined;
}

function resolveCacheRetention(cacheRetention?: Stream.CacheRetention): Stream.CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
		return "long";
	}
	return "short";
}

function getCacheControl(
	baseUrl: string,
	cacheRetention?: Stream.CacheRetention,
): { retention: Stream.CacheRetention; cacheControl?: { type: "ephemeral"; ttl?: "1h" } } {
	const retention = resolveCacheRetention(cacheRetention);
	if (retention === "none") {
		return { retention };
	}
	const ttl = retention === "long" && baseUrl.includes("api.anthropic.com") ? "1h" : undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

const claudeCodeVersion = "2.1.2";
const claudeCodeTools = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
];
const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));

const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;
const fromClaudeCodeName = (name: string, tools?: Message.Tool[]) => {
	if (tools && tools.length > 0) {
		const lowerName = name.toLowerCase();
		const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
		if (matchedTool) return matchedTool.name;
	}
	return name;
};

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

function mergeHeaders(...headerSources: (Record<string, string> | undefined)[]): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

function createClient(
	model: Model.TModel<typeof Model.KnownProtocolEnum.anthropicMessages>,
	apiKey: string,
	interleavedThinking: boolean,
	optionsHeaders?: Record<string, string>,
): { client: Anthropic; isOAuthToken: boolean } {
	const betaFeatures = ["fine-grained-tool-streaming-2025-05-14"];
	if (interleavedThinking) {
		betaFeatures.push("interleaved-thinking-2025-05-14");
	}

	const oauthToken = isOAuthToken(apiKey);
	if (oauthToken) {
		const defaultHeaders = mergeHeaders(
			{
				accept: "application/json",
				"anthropic-dangerous-direct-browser-access": "true",
				"anthropic-beta": `claude-code-20250219,oauth-2025-04-20,${betaFeatures.join(",")}`,
				"user-agent": `claude-cli/${claudeCodeVersion} (external, cli)`,
				"x-app": "cli",
			},
			model.headers,
			optionsHeaders,
		);

		return {
			client: new Anthropic({
				apiKey: null,
				authToken: apiKey,
				baseURL: model.baseUrl,
				defaultHeaders,
				dangerouslyAllowBrowser: true,
			}),
			isOAuthToken: true,
		};
	}

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

function buildSyntheticToolResult(
	block: Extract<Message.ToolCall, { status: "pending" | "running" }>,
): ContentBlockParam {
	return {
		type: "tool_result",
		tool_use_id: block.callID,
		content: convertContentBlocks([
			{ type: "text", text: ["<result>", "No Result Provided", "</result>"].join("\n") },
		]),
		is_error: true,
	};
}

function convertMessages(
	messages: Message.Message[],
	model: Model.TModel<typeof Model.KnownProtocolEnum.anthropicMessages>,
	isOAuthToken: boolean,
	cacheControl?: { type: "ephemeral"; ttl?: "1h" },
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
					name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
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
					(lastBlock as { cache_control?: { type: "ephemeral"; ttl?: "1h" } }).cache_control = cacheControl;
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

function convertTools(tools: Message.Tool[], isOAuthToken: boolean): Anthropic.Messages.Tool[] {
	if (!tools) return [];

	return tools.map((tool) => {
		const jsonSchema = tool.parameters as any; // TypeBox already generates JSON Schema

		return {
			name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
			description: tool.description,
			input_schema: {
				type: "object" as const,
				properties: jsonSchema.properties || {},
				required: jsonSchema.required || [],
			},
		};
	});
}

function mapStopReason(reason: Anthropic.Messages.StopReason | string): Message.StopReason {
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
			throw new Error(`Unhandled stop reason: ${reason}`);
	}
}

function buildParams(
	model: Model.TModel<typeof Model.KnownProtocolEnum.anthropicMessages>,
	context: Message.Context,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
): MessageCreateParamsStreaming {
	const { cacheControl } = getCacheControl(model.baseUrl, options?.cacheRetention);
	const params: MessageCreateParamsStreaming = {
		model: model.id,
		messages: convertMessages(context.messages, model, isOAuthToken, cacheControl),
		max_tokens: options?.maxTokens || (model.maxTokens / 3) | 0,
		stream: true,
	};

	if (isOAuthToken) {
		params.system = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
		if (context.systemPrompt) {
			params.system.push({
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			});
		}
	} else if (context.systemPrompt) {
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
		params.tools = convertTools(context.tools, isOAuthToken);
	}

	if (options?.thinkingEnabled && model.reasoning) {
		params.thinking = {
			type: "enabled",
			budget_tokens: options.thinkingBudgetTokens || 1024,
		};
	}

	if (options?.metadata) {
		const userId = options.metadata.user_id;
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

export const streamAnthropic: Stream.StreamFunction<
	typeof Model.KnownProtocolEnum.anthropicMessages,
	AnthropicOptions
> = (
	model: Model.TModel<typeof Model.KnownProtocolEnum.anthropicMessages>,
	context: Message.Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: Message.AssistantMessage = {
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
		};

		try {
			let client: Anthropic;
			let isOAuthToken: boolean;

			if (options?.client) {
				client = options.client;
				isOAuthToken = false;
			} else {
				const apiKey = options?.apiKey ?? getEnvApiKey(model.provider);
				if (!apiKey) {
					throw new Error(`No API key for provider: ${model.provider.id}`);
				}

				const created = createClient(model, apiKey, options?.interleavedThinking ?? true, options?.headers);
				client = created.client;
				isOAuthToken = created.isOAuthToken;
			}

			let params = buildParams(model, context, isOAuthToken, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as MessageCreateParamsStreaming;
			}
			const anthropicStream = client.messages.stream({ ...params, stream: true }, { signal: options?.signal });
			stream.push({ type: "start", partial: output });

			const blocks = output.parts as Block[];

			for await (const event of anthropicStream) {
				if (event.type === "message_start") {
					output.responseID = event.message.id;
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
						stream.push({ type: "text.start", partIndex: output.parts.length - 1, partial: output });
					} else if (event.content_block.type === "thinking") {
						const block: Block = {
							type: "thinking",
							thinking: "",
							thinkingSignature: "",
							index: event.index,
						};
						output.parts.push(block);
						stream.push({ type: "thinking.start", partIndex: output.parts.length - 1, partial: output });
					} else if (event.content_block.type === "redacted_thinking") {
						const block: Block = {
							type: "thinking",
							thinking: "[Reasoning redacted]",
							thinkingSignature: event.content_block.data,
							redacted: true,
							index: event.index,
						};
						output.parts.push(block);
						stream.push({ type: "thinking.start", partIndex: output.parts.length - 1, partial: output });
					} else if (event.content_block.type === "tool_use") {
						const block: Block = {
							type: "toolCall",
							callID: event.content_block.id,
							name: isOAuthToken
								? fromClaudeCodeName(event.content_block.name, context.tools)
								: event.content_block.name,
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
						stream.push({ type: "toolcall.start", partIndex: output.parts.length - 1, partial: output });
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

export const streamSimpleAnthropic: Stream.StreamFunction<
	typeof Model.KnownProtocolEnum.anthropicMessages,
	Stream.SimpleOptions
> = (
	model: Model.TModel<typeof Model.KnownProtocolEnum.anthropicMessages>,
	context: Message.Context,
	options?: Stream.SimpleOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider.id}`);
	}

	const base = Stream.buildBaseOptions(model, options, apiKey);
	if (!options?.reasoning) {
		return streamAnthropic(model, context, { ...base, thinkingEnabled: false } satisfies AnthropicOptions);
	}

	const adjusted = Stream.adjustMaxTokensForThinking(
		base.maxTokens || 0,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);

	return streamAnthropic(model, context, {
		...base,
		maxTokens: adjusted.maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: adjusted.thinkingBudget,
	} satisfies AnthropicOptions);
};

const anthropicProtocolProvider: Stream.ProtocolProvider<
	typeof Model.KnownProtocolEnum.anthropicMessages,
	AnthropicOptions
> = {
	protocol: Model.KnownProtocolEnum.anthropicMessages,
	stream: streamAnthropic,
	streamSimple: streamSimpleAnthropic,
};

export default anthropicProtocolProvider;
