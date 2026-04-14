import OpenAI from "openai";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionMessageParam,
	ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import { Message } from "../../../message/message";
import { Model } from "../../../model/model";
import { AssistantMessageEventStream } from "../../../utils/eventstream";
import { parseStreamingJson } from "../../../utils/jsonparse";
import { sanitizeSurrogates } from "../../../utils/sanitize";
import { Provider } from "../../provider";
import { Stream } from "../../stream";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "../github/github";
import { getEnvApiKey } from "../utils";

type OpenAIReasoningEffort = keyof Provider.StrictReasoningEffortMap;

type StreamingToolCallBlock = Message.ToolCall & {
	index?: number;
	partialArgs?: string;
	streamIndex?: number;
};

type StreamingBlock =
	| (Message.TextContent & { index?: number })
	| (Message.ThinkingContent & { index?: number })
	| StreamingToolCallBlock;

function hasToolHistory(messages: Message.Message[]): boolean {
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		if (msg.parts.some((block) => block.type === "toolCall")) {
			return true;
		}
	}
	return false;
}

function buildSyntheticToolResult(
	block: Extract<Message.ToolCall, { status: "pending" | "running" }>,
	compat: Required<Model.OpenAICompletionsCompat>,
): ChatCompletionToolMessageParam {
	const message: ChatCompletionToolMessageParam = {
		role: "tool",
		content: "No Result Provided",
		tool_call_id: block.callID,
	};
	if (compat.requiresToolResultName) {
		(message as ChatCompletionToolMessageParam & { name?: string }).name = block.name;
	}
	return message;
}

export interface OpenAICompletionsOptions extends Stream.Options {
	toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
	reasoningEffort?: OpenAIReasoningEffort;
}

export const streamOpenAICompletions: Stream.StreamFunction<
	typeof Model.KnownProtocolEnum.openaiCompletions,
	OpenAICompletionsOptions
> = (
	model: Model.TModel<typeof Model.KnownProtocolEnum.openaiCompletions>,
	context: Message.Context,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
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
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const client = createClient(model, context, apiKey, options?.headers);
			let params = buildParams(model, context, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
			}

			const openaiStream = await client.chat.completions.create(params, { signal: options?.signal });
			stream.push({ type: "start", partial: output });

			let currentBlock: Exclude<StreamingBlock, StreamingToolCallBlock> | null = null;
			const blocks = output.parts as StreamingBlock[];
			const activeToolCalls = new Map<number, StreamingToolCallBlock>();
			const finishCurrentBlock = (block?: StreamingBlock | null) => {
				if (block) {
					const partIndex = block.index ?? blocks.indexOf(block);
					delete block.index;

					if (block.type === "text") {
						stream.push({
							type: "text.end",
							partIndex,
							content: block.text,
							partial: output,
						});
					} else if (block.type === "thinking") {
						stream.push({
							type: "thinking.end",
							partIndex,
							content: block.thinking,
							partial: output,
						});
					} else if (block.type === "toolCall") {
						if (block.streamIndex !== undefined) {
							activeToolCalls.delete(block.streamIndex);
						}
						block.arguments = parseStreamingJson<Record<string, unknown>>(block.partialArgs);
						delete block.partialArgs;
						delete block.streamIndex;
						stream.push({
							type: "toolcall.end",
							partIndex,
							toolCall: block,
							partial: output,
						});
					}
				}
			};
			const flushActiveToolCalls = () => {
				for (const toolBlock of [...activeToolCalls.values()].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) {
					finishCurrentBlock(toolBlock);
				}
			};

			for await (const chunk of openaiStream) {
				if (!chunk || typeof chunk !== "object") continue;

				// OpenAI documents ChatCompletionChunk.id as the unique chat completion identifier,
				// and each chunk in a streamed completion carries the same id.
				output.responseId ||= chunk.id;
				if (chunk.usage) {
					output.usage = parseChunkUsage(chunk.usage, model);
				}

				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
				if (!choice) continue;

				const choiceWithUsage = choice as unknown as {
					usage?: Parameters<typeof parseChunkUsage>[0];
				};
				if (!chunk.usage && choiceWithUsage.usage) {
					output.usage = parseChunkUsage(choiceWithUsage.usage, model);
				}

				if (choice.finish_reason) {
					const finishReasonResult = mapStopReason(choice.finish_reason);
					output.stopReason = finishReasonResult.stopReason;
					if (finishReasonResult.errorMessage) {
						output.errorMessage = finishReasonResult.errorMessage;
					}
				}

				if (!choice.delta) continue;

				if (
					choice.delta.content !== null &&
					choice.delta.content !== undefined &&
					choice.delta.content.length > 0
				) {
					if (activeToolCalls.size > 0) {
						flushActiveToolCalls();
					}
					if (!currentBlock || currentBlock.type !== "text") {
						finishCurrentBlock(currentBlock);
						currentBlock = { type: "text", text: "", index: output.parts.length };
						output.parts.push(currentBlock);
						stream.push({
							type: "text.start",
							partIndex: currentBlock.index!,
							partial: output,
						});
					}

					if (currentBlock.type === "text") {
						currentBlock.text += choice.delta.content;
						stream.push({
							type: "text.delta",
							partIndex: currentBlock.index!,
							delta: choice.delta.content,
							partial: output,
						});
					}
				}

				const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"] as const;
				let foundReasoningField: (typeof reasoningFields)[number] | null = null;
				for (const field of reasoningFields) {
					const value = (choice.delta as Record<string, unknown>)[field];
					if (typeof value === "string" && value.length > 0) {
						foundReasoningField = field;
						break;
					}
				}

				if (foundReasoningField) {
					if (activeToolCalls.size > 0) {
						flushActiveToolCalls();
					}
					if (!currentBlock || currentBlock.type !== "thinking") {
						finishCurrentBlock(currentBlock);
						currentBlock = {
							type: "thinking",
							thinking: "",
							thinkingSignature: foundReasoningField,
							index: output.parts.length,
						};
						output.parts.push(currentBlock);
						stream.push({
							type: "thinking.start",
							partIndex: currentBlock.index!,
							partial: output,
						});
					}

					if (currentBlock.type === "thinking") {
						const delta = (choice.delta as Record<string, unknown>)[foundReasoningField];
						if (typeof delta === "string") {
							currentBlock.thinking += delta;
							stream.push({
								type: "thinking.delta",
								partIndex: currentBlock.index!,
								delta,
								partial: output,
							});
						}
					}
				}

				if (choice.delta.tool_calls) {
					if (currentBlock) {
						finishCurrentBlock(currentBlock);
						currentBlock = null;
					}

					for (const toolCall of choice.delta.tool_calls) {
						const streamIndex = toolCall.index ?? activeToolCalls.size;
						let toolBlock = activeToolCalls.get(streamIndex);
						if (!toolBlock) {
							toolBlock = {
								type: "toolCall",
								callID: toolCall.id || "",
								name: toolCall.function?.name || "",
								arguments: {},
								partialArgs: "",
								index: output.parts.length,
								streamIndex,
								status: "pending",
								time: {
									start: Date.now(),
									end: Date.now(),
								},
							};
							activeToolCalls.set(streamIndex, toolBlock);
							output.parts.push(toolBlock);
							stream.push({
								type: "toolcall.start",
								partIndex: toolBlock.index!,
								partial: output,
							});
						}

						if (toolCall.id) toolBlock.callID = toolCall.id;
						if (toolCall.function?.name) toolBlock.name = toolCall.function.name;

						let delta = "";
						if (toolCall.function?.arguments) {
							delta = toolCall.function.arguments;
							toolBlock.partialArgs = (toolBlock.partialArgs || "") + delta;
							toolBlock.arguments = parseStreamingJson<Record<string, unknown>>(toolBlock.partialArgs);
						}

						toolBlock.time.end = Date.now();
						stream.push({
							type: "toolcall.delta",
							partIndex: toolBlock.index!,
							delta,
							partial: output,
						});
					}
				}

				const reasoningDetails = (choice.delta as { reasoning_details?: Array<Record<string, unknown>> })
					.reasoning_details;
				if (reasoningDetails && Array.isArray(reasoningDetails)) {
					for (const detail of reasoningDetails) {
						if (
							detail.type === "reasoning.encrypted" &&
							typeof detail.id === "string" &&
							detail.data !== undefined
						) {
							const matchingToolCall = output.parts.find(
								(block) => block.type === "toolCall" && block.callID === detail.id,
							) as Message.ToolCall | undefined;
							if (matchingToolCall) {
								matchingToolCall.thoughtSignature = JSON.stringify(detail);
							}
						}
					}
				}
			}

			finishCurrentBlock(currentBlock);
			flushActiveToolCalls();
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}
			if (output.stopReason === "aborted") {
				throw new Error("Request was aborted");
			}
			if (output.stopReason === "error") {
				throw new Error(output.errorMessage || "Provider returned an error stop reason");
			}

			output.time.completed = Date.now();
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.parts) {
				delete (block as StreamingBlock).index;
				delete (block as StreamingToolCallBlock).partialArgs;
				delete (block as StreamingToolCallBlock).streamIndex;
			}
			output.time.completed = Date.now();
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			const rawMetadata = (error as { error?: { metadata?: { raw?: string } } })?.error?.metadata?.raw;
			if (rawMetadata) output.errorMessage += `\n${rawMetadata}`;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimpleOpenAICompletions: Stream.StreamFunction<
	typeof Model.KnownProtocolEnum.openaiCompletions,
	Stream.SimpleOptions
> = (
	model: Model.TModel<typeof Model.KnownProtocolEnum.openaiCompletions>,
	context: Message.Context,
	options?: Stream.SimpleOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider.id}`);
	}

	const base = Stream.buildBaseOptions(model, options, apiKey);
	const simpleReasoning = Model.supportsXhigh(model) ? options?.reasoning : Stream.clampReasoning(options?.reasoning);
	const reasoningEffort: OpenAIReasoningEffort | undefined =
		simpleReasoning && simpleReasoning !== Stream.ThinkingLevelEnum.off ? simpleReasoning : undefined;
	const toolChoice = (options as OpenAICompletionsOptions | undefined)?.toolChoice;

	return streamOpenAICompletions(model, context, {
		...base,
		reasoningEffort,
		toolChoice,
	} satisfies OpenAICompletionsOptions);
};

function buildParams(
	model: Model.TModel<typeof Model.KnownProtocolEnum.openaiCompletions>,
	context: Message.Context,
	options?: OpenAICompletionsOptions,
) {
	const compat = getCompat(model);
	const messages = convertMessages(model, context, compat);
	maybeAddOpenRouterAnthropicCacheControl(model, messages);

	const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: model.id,
		messages,
		stream: true,
	};

	if (compat.supportsUsageInStreaming !== false) {
		(params as typeof params & { stream_options?: { include_usage: boolean } }).stream_options = {
			include_usage: true,
		};
	}

	if (compat.supportsStore) {
		params.store = false;
	}

	if (options?.maxTokens) {
		if (compat.maxTokensField === "max_tokens") {
			(params as typeof params & { max_tokens?: number }).max_tokens = options.maxTokens;
		} else {
			params.max_completion_tokens = options.maxTokens;
		}
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	if (context.tools) {
		params.tools = convertTools(context.tools, compat);
		if (compat.zaiToolStream) {
			(params as typeof params & { tool_stream?: boolean }).tool_stream = true;
		}
	} else if (hasToolHistory(context.messages)) {
		params.tools = [];
	}

	if (options?.toolChoice) {
		params.tool_choice = options.toolChoice;
	}

	if ((compat.thinkingFormat === "zai" || compat.thinkingFormat === "qwen") && model.reasoning) {
		(params as typeof params & { enable_thinking?: boolean }).enable_thinking = !!options?.reasoningEffort;
	} else if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
		(params as typeof params & { chat_template_kwargs?: { enable_thinking: boolean } }).chat_template_kwargs = {
			enable_thinking: !!options?.reasoningEffort,
		};
	} else if (compat.thinkingFormat === "openrouter" && model.reasoning) {
		const openRouterParams = params as typeof params & { reasoning?: { effort?: string } };
		if (options?.reasoningEffort) {
			openRouterParams.reasoning = {
				effort: mapReasoningEffort(options.reasoningEffort, compat.reasoningEffortMap),
			};
		} else {
			openRouterParams.reasoning = { effort: "none" };
		}
	} else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
		(params as { reasoning_effort?: string }).reasoning_effort = mapReasoningEffort(
			options.reasoningEffort,
			compat.reasoningEffortMap,
		);
	}

	if (model.baseUrl.includes("openrouter.ai") && model.compat?.openRouterRouting) {
		(params as typeof params & { provider?: Provider.OpenRouterRouting }).provider = model.compat.openRouterRouting;
	}

	if (model.baseUrl.includes("ai-gateway.vercel.sh") && model.compat?.vercelGatewayRouting) {
		const routing = model.compat.vercelGatewayRouting;
		if (routing.only || routing.order) {
			const gatewayOptions: Record<string, string[]> = {};
			if (routing.only) gatewayOptions.only = routing.only;
			if (routing.order) gatewayOptions.order = routing.order;
			(
				params as typeof params & {
					providerOptions?: { gateway: Record<string, string[]> };
				}
			).providerOptions = { gateway: gatewayOptions };
		}
	}

	return params;
}

function createClient(
	model: Model.TModel<typeof Model.KnownProtocolEnum.openaiCompletions>,
	context: Message.Context,
	apiKey?: string,
	optsHeaders?: Record<string, string>,
) {
	if (!apiKey) {
		if (!process.env.OPENAI_API_KEY) {
			throw new Error(
				"OpenAI API key is required. set OPENAI_API_KEY environment variable or pass it as an argument",
			);
		}
		apiKey = process.env.OPENAI_API_KEY;
	}

	const headers = { ...model.headers };
	if (model.provider.id === Provider.KnownProviderEnum.githubCopilot) {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		Object.assign(headers, copilotHeaders);
	}

	if (optsHeaders) {
		Object.assign(headers, optsHeaders);
	}

	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders: headers,
	});
}

function mapReasoningEffort(
	effort: NonNullable<OpenAICompletionsOptions["reasoningEffort"]>,
	reasoningEffortMap: Partial<Record<OpenAIReasoningEffort, string>>,
): string {
	return reasoningEffortMap[effort] ?? effort;
}

function maybeAddOpenRouterAnthropicCacheControl(
	model: Model.TModel<typeof Model.KnownProtocolEnum.openaiCompletions>,
	messages: ChatCompletionMessageParam[],
): void {
	if (model.provider.id !== Provider.KnownProviderEnum.openrouter || !model.id.startsWith("anthropic/")) return;

	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg) continue;
		if (msg.role !== "user" && msg.role !== "assistant") continue;

		const content = msg.content;
		if (typeof content === "string") {
			msg.content = [
				Object.assign({ type: "text" as const, text: content }, { cache_control: { type: "ephemeral" } }),
			];
			return;
		}

		if (!Array.isArray(content)) continue;

		for (let j = content.length - 1; j >= 0; j--) {
			const part = content[j];
			if (part?.type === "text") {
				Object.assign(part, { cache_control: { type: "ephemeral" } });
				return;
			}
		}
	}
}

export function convertMessages(
	model: Model.TModel<typeof Model.KnownProtocolEnum.openaiCompletions>,
	context: Message.Context,
	compat: Required<Model.OpenAICompletionsCompat>,
): ChatCompletionMessageParam[] {
	const params: ChatCompletionMessageParam[] = [];

	const normalizeToolCallId = (id: string): string => {
		// handle pipe-separated IDs from OpenAI Responses API
		// format: {call_id}|{id} where {id} can be 400+ chars with special chars (+, /, =)
		// these come from providers like github-copilot, openai-codex, opencode
		// extract just the call_id part and normalize it
		if (id.includes("|")) {
			const callID = id.split("|")[0] ?? id;
			// sanitize to allowed chars and truncate to 40 chars (OpenAI limit)
			return callID.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
		}

		if (model.provider.id === Provider.KnownProviderEnum.openai) {
			return id.length > 40 ? id.slice(0, 40) : id;
		}
		return id;
	};

	const transformedMessages = Message.transformMessages(context.messages, model, normalizeToolCallId);

	if (context.systemPrompt) {
		const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
		const role = useDeveloperRole ? "developer" : "system";
		params.push({
			role,
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	let lastRole: "user" | "assistant" | "tool" | null = null;

	for (const msg of transformedMessages) {
		// some providers don't allow user messages directly after tool results
		// insert a synthetic assistant message to bridge the gap
		if (compat.requiresAssistantAfterToolResult && lastRole === "tool" && msg.role === "user") {
			params.push({
				role: "assistant",
				content: "I have processed the tool results.",
			});
			lastRole = "assistant";
		}

		if (msg.role === "user") {
			const content: ChatCompletionContentPart[] = msg.parts.flatMap((item): ChatCompletionContentPart[] => {
				if (item.type === "text") {
					const text = sanitizeSurrogates(item.text);
					if (text.trim().length === 0) return [];
					return [
						{
							type: "text",
							text,
						} satisfies ChatCompletionContentPartText,
					];
				}

				if (!model.input.includes("image")) return [];
				return [
					{
						type: "image_url",
						image_url: {
							url: `data:${item.mimeType};base64,${item.data}`,
						},
					} satisfies ChatCompletionContentPartImage,
				];
			});

			if (content.length === 0) continue;

			params.push({
				role: "user",
				content,
			});
			lastRole = "user";
			continue;
		}

		const assistantMsg: ChatCompletionAssistantMessageParam = {
			role: "assistant",
			content: compat.requiresAssistantAfterToolResult ? "" : null,
		};

		const textBlocks = msg.parts.filter((block) => block.type === "text") as Message.TextContent[];
		const textSegments = textBlocks
			.map((block) => sanitizeSurrogates(block.text))
			.filter((text) => text.trim().length > 0);

		const thinkingBlocks = msg.parts.filter((block) => block.type === "thinking") as Message.ThinkingContent[];
		const nonEmptyThinkingBlocks = thinkingBlocks.filter((block) => block.thinking.trim().length > 0);

		if (compat.requiresThinkingAsText && nonEmptyThinkingBlocks.length > 0) {
			textSegments.unshift(...nonEmptyThinkingBlocks.map((block) => sanitizeSurrogates(block.thinking)));
		} else if (nonEmptyThinkingBlocks.length > 0) {
			const signature = nonEmptyThinkingBlocks[0]?.thinkingSignature;
			if (signature && signature.length > 0) {
				(assistantMsg as ChatCompletionAssistantMessageParam & Record<string, string>)[signature] =
					nonEmptyThinkingBlocks.map((block) => sanitizeSurrogates(block.thinking)).join("\n");
			}
		}

		if (textSegments.length > 0) {
			assistantMsg.content = textSegments.join("");
		}

		const toolCalls = msg.parts.filter((block) => block.type === "toolCall") as Message.ToolCall[];
		if (toolCalls.length > 0) {
			assistantMsg.tool_calls = toolCalls.map((toolCall) => ({
				id: toolCall.callID,
				type: "function" as const,
				function: {
					name: toolCall.name,
					arguments: JSON.stringify(toolCall.arguments),
				},
			}));

			const reasoningDetails = toolCalls
				.filter((toolCall) => toolCall.thoughtSignature)
				.map((toolCall) => {
					try {
						return JSON.parse(toolCall.thoughtSignature!);
					} catch {
						return null;
					}
				})
				.filter(Boolean);

			if (reasoningDetails.length > 0) {
				(
					assistantMsg as ChatCompletionAssistantMessageParam & { reasoning_details?: unknown[] }
				).reasoning_details = reasoningDetails;
			}
		}

		const assistantContent = assistantMsg.content;
		const hasAssistantContent =
			assistantContent !== null &&
			assistantContent !== undefined &&
			(typeof assistantContent === "string" ? assistantContent.length > 0 : assistantContent.length > 0);
		if (!hasAssistantContent && !assistantMsg.tool_calls) {
			continue;
		}

		params.push(assistantMsg);
		lastRole = "assistant";

		const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];

		for (const toolCall of toolCalls) {
			if (toolCall.status === "pending" || toolCall.status === "running") {
				params.push(buildSyntheticToolResult(toolCall, compat));
				lastRole = "tool";
				continue;
			}

			const textResult = toolCall.result.content
				.filter((content) => content.type === "text")
				.map((content) => content.text)
				.join("\n");
			const hasImages = toolCall.result.content.some((content) => content.type === "image");

			const toolResultMsg: ChatCompletionToolMessageParam = {
				role: "tool",
				content: sanitizeSurrogates(textResult.length > 0 ? textResult : "(see attached image)"),
				tool_call_id: toolCall.callID,
			};
			if (compat.requiresToolResultName) {
				(toolResultMsg as ChatCompletionToolMessageParam & { name?: string }).name = toolCall.name;
			}
			params.push(toolResultMsg);
			lastRole = "tool";

			if (hasImages && model.input.includes("image")) {
				for (const block of toolCall.result.content) {
					if (block.type === "image") {
						imageBlocks.push({
							type: "image_url",
							image_url: {
								url: `data:${block.mimeType};base64,${block.data}`,
							},
						});
					}
				}
			}
		}

		if (imageBlocks.length > 0) {
			if (compat.requiresAssistantAfterToolResult) {
				params.push({
					role: "assistant",
					content: "I have processed the tool results.",
				});
			}

			params.push({
				role: "user",
				content: [
					{
						type: "text",
						text: "Attached image(s) from tool result:",
					},
					...imageBlocks,
				],
			});
			lastRole = "user";
		}
	}

	return params;
}

function convertTools(
	tools: Message.Tool[],
	compat: Required<Model.OpenAICompletionsCompat>,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as Record<string, unknown>,
			...(compat.supportsStrictMode !== false && { strict: false }),
		},
	}));
}

function parseChunkUsage(
	rawUsage: {
		prompt_tokens?: number;
		completion_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
		completion_tokens_details?: { reasoning_tokens?: number };
	},
	model: Model.TModel<typeof Model.KnownProtocolEnum.openaiCompletions>,
): Message.AssistantMessage["usage"] {
	const promptTokens = rawUsage.prompt_tokens || 0;
	const reportedCachedTokens = rawUsage.prompt_tokens_details?.cached_tokens || 0;
	const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;
	const reasoningTokens = rawUsage.completion_tokens_details?.reasoning_tokens || 0;

	const cacheReadTokens =
		cacheWriteTokens > 0 ? Math.max(0, reportedCachedTokens - cacheWriteTokens) : reportedCachedTokens;

	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	const outputTokens = (rawUsage.completion_tokens || 0) + reasoningTokens;
	const usage: Message.AssistantMessage["usage"] = {
		input,
		output: outputTokens,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	Model.calculateCost(model, usage);
	return usage;
}

function mapStopReason(reason: string | null): {
	stopReason: Message.StopReason;
	errorMessage?: string;
} {
	if (reason === null) return { stopReason: "stop" };
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
		case "network_error":
			return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
		default:
			return {
				stopReason: "error",
				errorMessage: `Provider finish_reason: ${reason}`,
			};
	}
}

function detectCompat(
	model: Model.TModel<typeof Model.KnownProtocolEnum.openaiCompletions>,
): Required<Model.OpenAICompletionsCompat> {
	const provider = model.provider.id;
	const baseUrl = model.baseUrl;

	const isZai = provider === "zai" || baseUrl.includes("api.z.ai");
	const isNonStandard =
		provider === "cerebras" ||
		baseUrl.includes("cerebras.ai") ||
		provider === "xai" ||
		baseUrl.includes("api.x.ai") ||
		baseUrl.includes("chutes.ai") ||
		baseUrl.includes("deepseek.com") ||
		isZai ||
		provider === "opencode" ||
		baseUrl.includes("opencode.ai");

	const useMaxTokens = baseUrl.includes("chutes.ai");
	const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
	const isGroq = provider === "groq" || baseUrl.includes("groq.com");

	const reasoningEffortMap: Partial<Record<OpenAIReasoningEffort, string>> =
		isGroq && model.id === "qwen/qwen3-32b"
			? {
					minimal: "default",
					low: "default",
					medium: "default",
					high: "default",
					xhigh: "default",
				}
			: {};

	return {
		supportsStore: !isNonStandard,
		supportsDeveloperRole: !isNonStandard,
		supportsReasoningEffort: !isGrok && !isZai,
		reasoningEffortMap,
		supportsUsageInStreaming: true,
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		thinkingFormat: isZai
			? "zai"
			: provider === "openrouter" || baseUrl.includes("openrouter.ai")
				? "openrouter"
				: "openai",
		openRouterRouting: {},
		vercelGatewayRouting: {},
		zaiToolStream: false,
		supportsStrictMode: true,
	};
}

/**
 * Get resolved compatibility settings for a model.
 * Uses explicit model.compat if provided, otherwise auto-detects from provider/URL.
 */
function getCompat(
	model: Model.TModel<typeof Model.KnownProtocolEnum.openaiCompletions>,
): Required<Model.OpenAICompletionsCompat> {
	const detected = detectCompat(model);
	if (!model.compat) return detected;

	return {
		supportsStore: model.compat.supportsStore ?? detected.supportsStore,
		supportsDeveloperRole: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
		supportsReasoningEffort: model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
		reasoningEffortMap: model.compat.reasoningEffortMap ?? detected.reasoningEffortMap,
		supportsUsageInStreaming: model.compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
		maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
		requiresToolResultName: model.compat.requiresToolResultName ?? detected.requiresToolResultName,
		requiresAssistantAfterToolResult:
			model.compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
		requiresThinkingAsText: model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
		thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
		openRouterRouting: model.compat.openRouterRouting ?? {},
		vercelGatewayRouting: model.compat.vercelGatewayRouting ?? detected.vercelGatewayRouting,
		zaiToolStream: model.compat.zaiToolStream ?? detected.zaiToolStream,
		supportsStrictMode: model.compat.supportsStrictMode ?? detected.supportsStrictMode,
	};
}

const openAICompletionsProtocolProvider: Stream.ProtocolProvider<
	typeof Model.KnownProtocolEnum.openaiCompletions,
	OpenAICompletionsOptions
> = {
	protocol: Model.KnownProtocolEnum.openaiCompletions,
	stream: streamOpenAICompletions,
	streamSimple: streamSimpleOpenAICompletions,
};

export default openAICompletionsProtocolProvider;
