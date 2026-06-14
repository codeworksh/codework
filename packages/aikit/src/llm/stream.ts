import { streamText, type TextStreamPart, type ToolSet } from "ai";
import { Message } from "../message/message";
import { Model } from "../model/model";
import { AssistantMessageEventStream } from "../utils/eventstream";
import { Options } from "./options";
import { Protocol } from "./protocol";
import { resolveAISDKLanguageModel } from "./provider";
import { formatThrownError } from "./runtime";
import { applyDefaultMaxTokens } from "./shared";
import {
	convertMessages,
	convertTools,
	createAssistantMessage,
	mapFinishReason,
	mapUsage,
	toolCallFromPart,
	updateToolCallFromInput,
	type StreamingToolCallBlock,
} from "./transform";

type TextBlock = Message.TextContent & { streamId?: string };
type ThinkingBlock = Message.ThinkingContent & { streamId?: string };

type StreamBlock = TextBlock | ThinkingBlock | StreamingToolCallBlock;
type RuntimeOptions = Options & Protocol.CommonOptions;
type ProviderOptionBag = Record<string, Record<string, unknown> | undefined>;

function providerOptionsKey(model: Model.Info): string {
	return model.providerOptionsKey ?? model.protocol;
}

function mergeProviderOptions(...sources: Array<ProviderOptionBag | undefined>): ProviderOptionBag {
	const result: ProviderOptionBag = {};
	for (const source of sources) {
		if (!source) continue;
		for (const [key, value] of Object.entries(source)) {
			if (!value) continue;
			result[key] = {
				...result[key],
				...value,
			};
		}
	}
	return result;
}

function configuredCacheRetention(options: RuntimeOptions): "none" | "short" | "long" | undefined {
	if (options.cacheRetention) return options.cacheRetention;
	const env = process.env.CODEWORK_CACHE_RETENTION;
	if (env === "none" || env === "short" || env === "long") return env;
}

function cacheProviderOptions(model: Model.Info, options: RuntimeOptions): ProviderOptionBag {
	const retention = configuredCacheRetention(options);
	const key = providerOptionsKey(model);

	if (retention === "none") return {};

	if (key === "openai") {
		const openai: Record<string, unknown> = {};
		if (options.sessionId) openai.promptCacheKey = options.sessionId;
		if (retention === "short") openai.promptCacheRetention = "in_memory";
		if (retention === "long") openai.promptCacheRetention = "24h";
		return Object.keys(openai).length > 0 ? { [key]: openai } : {};
	}

	if (key === "openai-codex" && options.sessionId) {
		return { [key]: { promptCacheKey: options.sessionId } };
	}

	if ((key === "anthropic" || key === "google-vertex-anthropic") && retention) {
		return {
			[key]: {
				cacheControl: {
					type: "ephemeral",
					...(retention === "long" ? { ttl: "1h" } : {}),
				},
			},
		};
	}

	return {};
}

// Default thinking budgets as a fraction of model.maxTokens, per level.
const DEFAULT_THINKING_BUDGET_FRACTIONS: Record<Model.ActiveThinkingLevel, number> = {
	minimal: 0.05,
	low: 0.1,
	medium: 0.25,
	high: 0.5,
	xhigh: 0.8,
};

const MIN_THINKING_BUDGET = 1024;

function resolveThinkingBudget(
	model: Model.Info,
	options: RuntimeOptions,
	level: Model.ActiveThinkingLevel,
): number | undefined {
	// Explicit budget from caller takes priority.
	const explicit = options.thinkingBudgets?.[level];
	if (explicit !== undefined) return explicit;

	// Compute a sensible default so @ai-sdk/anthropic does not warn.
	const key = providerOptionsKey(model);
	if (key === "anthropic" || key === "google-vertex-anthropic") {
		const fraction = DEFAULT_THINKING_BUDGET_FRACTIONS[level];
		return Math.max(Math.floor(model.maxTokens * fraction), MIN_THINKING_BUDGET);
	}

	return undefined;
}

function reasoningProviderOptions(model: Model.Info, options: RuntimeOptions): ProviderOptionBag {
	const requestedLevel = options.reasoning;
	if (!requestedLevel) return {};

	const level = Model.clampThinkingLevel(model, requestedLevel);
	if (level === "off") return {};

	const mapped = model.thinkingLevelMap?.[level] ?? level;
	if (!mapped) return {};

	const key = providerOptionsKey(model);
	const budget = resolveThinkingBudget(model, options, level);

	if (key === "openai" || key === "xai" || key === "openai-codex") {
		return { [key]: { reasoningEffort: mapped } };
	}

	if (key === "openrouter") {
		return {
			[key]: {
				reasoning: {
					effort: mapped === "off" ? "none" : mapped,
				},
			},
		};
	}

	if (key === "google" || key === "google-vertex") {
		const thinkingLevel = mapped === "xhigh" ? "high" : mapped;
		return {
			[key]: {
				thinkingConfig: {
					thinkingLevel,
					includeThoughts: true,
					...(budget !== undefined ? { thinkingBudget: budget } : {}),
				},
			},
		};
	}

	if (key === "anthropic" || key === "google-vertex-anthropic") {
		return {
			[key]: {
				thinking: {
					type: "enabled",
					budgetTokens: budget ?? MIN_THINKING_BUDGET,
				},
			},
		};
	}

	return {};
}

function resolveProviderOptions(model: Model.Info, options: RuntimeOptions): ProviderOptionBag {
	return mergeProviderOptions(
		model.providerOptions as ProviderOptionBag | undefined,
		cacheProviderOptions(model, options),
		reasoningProviderOptions(model, options),
		options.providerOptions as ProviderOptionBag | undefined,
	);
}

function partIndex(output: Message.AssistantMessage, block: StreamBlock): number {
	return output.parts.indexOf(block as Message.AssistantMessage["parts"][number]);
}

function ensureTextBlock(output: Message.AssistantMessage, id: string, stream: AssistantMessageEventStream): TextBlock {
	const existing = output.parts.find((part) => part.type === "text" && (part as TextBlock).streamId === id) as
		| TextBlock
		| undefined;
	if (existing) return existing;

	const block: TextBlock = { type: "text", text: "", streamId: id };
	output.parts.push(block);
	stream.push({ type: "text.start", partIndex: partIndex(output, block), partial: output });
	return block;
}

function ensureThinkingBlock(
	output: Message.AssistantMessage,
	id: string,
	stream: AssistantMessageEventStream,
): ThinkingBlock {
	const existing = output.parts.find((part) => part.type === "thinking" && (part as ThinkingBlock).streamId === id) as
		| ThinkingBlock
		| undefined;
	if (existing) return existing;

	const block: ThinkingBlock = { type: "thinking", thinking: "", streamId: id };
	output.parts.push(block);
	stream.push({ type: "thinking.start", partIndex: partIndex(output, block), partial: output });
	return block;
}

function ensureToolCallBlock(
	output: Message.AssistantMessage,
	id: string,
	name: string,
	stream: AssistantMessageEventStream,
	emitStart: boolean,
): StreamingToolCallBlock {
	const existing = output.parts.find((part) => part.type === "toolCall" && part.callID === id) as
		| StreamingToolCallBlock
		| undefined;
	if (existing) {
		if (!existing.name && name) existing.name = name;
		return existing;
	}

	const block: StreamingToolCallBlock = {
		type: "toolCall",
		callID: id,
		name,
		arguments: {},
		status: "pending",
		time: {
			start: Date.now(),
			end: Date.now(),
		},
	};
	output.parts.push(block);
	if (emitStart) {
		stream.push({ type: "toolcall.start", partIndex: partIndex(output, block), partial: output });
	}
	return block;
}

function finishTextBlock(output: Message.AssistantMessage, id: string, stream: AssistantMessageEventStream): void {
	const block = output.parts.find((part) => part.type === "text" && (part as TextBlock).streamId === id) as
		| TextBlock
		| undefined;
	if (!block) return;
	const index = partIndex(output, block);
	delete (block as { streamId?: string }).streamId;
	stream.push({ type: "text.end", partIndex: index, content: block.text, partial: output });
}

function finishThinkingBlock(output: Message.AssistantMessage, id: string, stream: AssistantMessageEventStream): void {
	const block = output.parts.find((part) => part.type === "thinking" && (part as ThinkingBlock).streamId === id) as
		| ThinkingBlock
		| undefined;
	if (!block) return;
	const index = partIndex(output, block);
	delete (block as { streamId?: string }).streamId;
	stream.push({ type: "thinking.end", partIndex: index, content: block.thinking, partial: output });
}

function finishToolInput(output: Message.AssistantMessage, id: string, stream: AssistantMessageEventStream): void {
	const block = output.parts.find((part) => part.type === "toolCall" && part.callID === id) as
		| StreamingToolCallBlock
		| undefined;
	if (!block) return;
	const index = partIndex(output, block);
	delete block.partialJson;
	stream.push({ type: "toolcall.end", partIndex: index, toolCall: block, partial: output });
}

function finalizeToolCall(
	output: Message.AssistantMessage,
	part: Extract<TextStreamPart<ToolSet>, { type: "tool-call" }>,
	stream: AssistantMessageEventStream,
): void {
	const existing = output.parts.find((item) => item.type === "toolCall" && item.callID === part.toolCallId) as
		| StreamingToolCallBlock
		| undefined;
	const block = existing ?? toolCallFromPart(part);
	block.callID = part.toolCallId;
	block.name = part.toolName;
	block.arguments =
		typeof part.input === "object" && part.input !== null ? (part.input as Record<string, unknown>) : {};
	block.time.end = Date.now();
	delete block.partialJson;

	if (!existing) {
		output.parts.push(block);
	}

	const index = partIndex(output, block);
	stream.push({ type: "toolcall.final", partIndex: index, toolCall: block, partial: output });
}

function handlePart(
	part: TextStreamPart<ToolSet>,
	output: Message.AssistantMessage,
	model: Model.Info,
	stream: AssistantMessageEventStream,
): void {
	switch (part.type) {
		case "text-start":
			ensureTextBlock(output, part.id, stream);
			break;
		case "text-delta": {
			const block = ensureTextBlock(output, part.id, stream);
			block.text += part.text;
			stream.push({ type: "text.delta", partIndex: partIndex(output, block), delta: part.text, partial: output });
			break;
		}
		case "text-end":
			finishTextBlock(output, part.id, stream);
			break;
		case "reasoning-start":
			ensureThinkingBlock(output, part.id, stream);
			break;
		case "reasoning-delta": {
			const block = ensureThinkingBlock(output, part.id, stream);
			block.thinking += part.text;
			// Capture the provider thinking signature for faithful multi-turn replay.
			// @ai-sdk/anthropic emits it as a reasoning-delta with empty text and providerMetadata.
			const sig =
				(part.providerMetadata?.anthropic as Record<string, unknown> | undefined)?.signature ??
				(part.providerMetadata?.["google-vertex-anthropic"] as Record<string, unknown> | undefined)?.signature;
			if (typeof sig === "string") block.thinkingSignature = sig;
			stream.push({
				type: "thinking.delta",
				partIndex: partIndex(output, block),
				delta: part.text,
				partial: output,
			});
			break;
		}
		case "reasoning-end":
			finishThinkingBlock(output, part.id, stream);
			break;
		case "tool-input-start":
			ensureToolCallBlock(output, part.id, part.toolName, stream, true);
			break;
		case "tool-input-delta": {
			const block = ensureToolCallBlock(output, part.id, "", stream, true);
			const partialJson = (block.partialJson ?? "") + part.delta;
			updateToolCallFromInput(block, partialJson);
			stream.push({
				type: "toolcall.delta",
				partIndex: partIndex(output, block),
				delta: part.delta,
				partial: output,
			});
			break;
		}
		case "tool-input-end":
			finishToolInput(output, part.id, stream);
			break;
		case "tool-call":
			finalizeToolCall(output, part, stream);
			break;
		case "finish-step":
			output.responseId ||= part.response.id;
			if (part.response.modelId && part.response.modelId !== model.id)
				output.responseModel ||= part.response.modelId;
			output.usage = mapUsage(part.usage, model);
			output.stopReason = mapFinishReason(part.finishReason);
			break;
		case "finish":
			output.usage = mapUsage(part.totalUsage, model);
			output.stopReason = mapFinishReason(part.finishReason);
			break;
		case "abort":
			output.stopReason = "aborted";
			output.errorMessage = part.reason;
			break;
		case "error":
			throw part.error instanceof Error ? part.error : new Error(formatThrownError(part.error));
	}
}

/**
 * Resolve maxOutputTokens so that (maxOutputTokens + thinkingBudget) does not exceed model.maxTokens.
 * Without this adjustment @ai-sdk/anthropic logs a warning and silently caps the value.
 */
function resolveMaxOutputTokens(
	model: Model.Info,
	options: RuntimeOptions,
	providerOptions: Record<string, unknown> | undefined,
): number | undefined {
	const maxTokens = options.maxTokens;
	if (maxTokens === undefined) return undefined;

	const key = providerOptionsKey(model);
	// The ChatGPT Codex backend rejects max_output_tokens, so never send it.
	if (key === "openai-codex") return undefined;

	if (key === "anthropic" || key === "google-vertex-anthropic") {
		const thinkingConfig = providerOptions?.[key] as Record<string, unknown> | undefined;
		const thinking = thinkingConfig?.thinking as { budgetTokens?: number } | undefined;
		const budgetTokens = thinking?.budgetTokens ?? 0;
		if (budgetTokens > 0 && maxTokens + budgetTokens > model.maxTokens) {
			return Math.max(model.maxTokens - budgetTokens, 1);
		}
	}

	return maxTokens;
}

export const stream: Protocol.StreamFunction<Model.KnownProviderEnum, typeof Options> = (model, context, options) => {
	const stream = new AssistantMessageEventStream();
	const runtimeOptions = applyDefaultMaxTokens(model, (options ?? {}) as RuntimeOptions);

	void (async () => {
		const output = createAssistantMessage(model);
		try {
			const languageModel = await resolveAISDKLanguageModel(model, runtimeOptions);
			const tools = convertTools(context.tools);
			const messages = convertMessages(context, model);
			const providerOptions = resolveProviderOptions(model, runtimeOptions) as Parameters<
				typeof streamText<ToolSet>
			>[0]["providerOptions"];
			const activeTools = runtimeOptions.activeTools?.filter((name) => !tools || name in tools);

			let params: Parameters<typeof streamText<ToolSet>>[0] = {
				model: languageModel,
				system: context.systemPrompt,
				messages,
				tools,
				toolChoice: runtimeOptions.toolChoice as Parameters<typeof streamText<ToolSet>>[0]["toolChoice"],
				activeTools,
				maxOutputTokens: resolveMaxOutputTokens(model, runtimeOptions, providerOptions),
				temperature: runtimeOptions.temperature,
				providerOptions,
				abortSignal: runtimeOptions.signal,
				timeout: runtimeOptions.timeoutMs,
				maxRetries: runtimeOptions.maxRetries,
				headers: runtimeOptions.headers,
			};

			const payload = await runtimeOptions.onPayload?.(params, model);
			if (payload !== undefined) {
				params = payload as Parameters<typeof streamText<ToolSet>>[0];
			}

			const result = streamText(params);
			stream.push({ type: "start", partial: output });

			for await (const part of result.fullStream) {
				handlePart(part, output, model, stream);
			}

			if (runtimeOptions.signal?.aborted || output.stopReason === "aborted") {
				throw new Error(output.errorMessage || "Request was aborted");
			}
			if (output.stopReason === "error") {
				throw new Error(output.errorMessage || "Provider returned an error stop reason");
			}

			output.time.completed = Date.now();
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.parts) {
				delete (block as TextBlock).streamId;
				delete (block as ThinkingBlock).streamId;
				delete (block as StreamingToolCallBlock).partialJson;
			}
			output.time.completed = Date.now();
			output.stopReason = runtimeOptions.signal?.aborted || output.stopReason === "aborted" ? "aborted" : "error";
			output.errorMessage = formatThrownError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};
