import { streamText, type TextStreamPart, type ToolSet } from "ai";
import * as Message from "../message/message.ts";
import * as Model from "../model/model.ts";
import { AssistantMessageEventStream } from "../utils/eventstream.ts";
import { compact } from "../utils/helpers.ts";
import * as Failure from "./failure.ts";
import { Options, type ProviderOptionBag, type RuntimeOptions } from "./options.ts";
import * as Pricing from "./pricing.ts";
import * as Protocol from "./protocol.ts";
import { resolveAISDKLanguageModel } from "./provider.ts";
import { formatThrownError } from "./runtime.ts";
import { applyDefaultMaxTokens } from "./shared.ts";
import * as Thinking from "./thinking.ts";
import {
	convertMessages,
	convertTools,
	createAssistantMessage,
	encodeOpenAIReasoningSignature,
	mapFinishReason,
	mapUsage,
	toolCallFromPart,
	updateToolCallFromInput,
	type StreamingToolCallBlock,
} from "./transform.ts";

type TextBlock = Message.TextContent & { streamId?: string };
type ThinkingBlock = Message.ThinkingContent & { streamId?: string };

type StreamBlock = TextBlock | ThinkingBlock | StreamingToolCallBlock;

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
	const key = Model.optionsKey(model);

	if (retention === "none") return {};

	if (key === "openai") {
		const openai: Record<string, unknown> = {};
		if (options.sessionId) openai.promptCacheKey = options.sessionId;
		if (retention === "short") openai.promptCacheRetention = "in_memory";
		if (retention === "long") openai.promptCacheRetention = "24h";
		return Object.keys(openai).length > 0 ? { [key]: openai } : {};
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

function resolveProviderOptions(model: Model.Info, options: RuntimeOptions, plan: Thinking.Plan): ProviderOptionBag {
	return mergeProviderOptions(
		model.providerOptions as ProviderOptionBag | undefined,
		cacheProviderOptions(model, options),
		Thinking.reasoningProviderOptions(model, plan),
		options.providerOptions as ProviderOptionBag | undefined,
	);
}

function partIndex(output: Message.AssistantMessage, block: StreamBlock): number {
	return output.parts.indexOf(block as Message.AssistantMessage["parts"][number]);
}

function openAICodexMetadata(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const metadata = (value as Record<string, unknown>)["openai-codex"];
	return typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
		? (metadata as Record<string, unknown>)
		: undefined;
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

function finishTextBlock(
	output: Message.AssistantMessage,
	id: string,
	stream: AssistantMessageEventStream,
	textSignature?: string,
): void {
	const block = output.parts.find((part) => part.type === "text" && (part as TextBlock).streamId === id) as
		| TextBlock
		| undefined;
	if (!block) return;
	if (textSignature) block.textSignature = textSignature;
	const index = partIndex(output, block);
	delete (block as { streamId?: string }).streamId;
	stream.push({ type: "text.end", partIndex: index, content: block.text, partial: output });
}

function finishThinkingBlock(
	output: Message.AssistantMessage,
	id: string,
	stream: AssistantMessageEventStream,
	thinkingSignature?: string,
): void {
	const block = output.parts.find((part) => part.type === "thinking" && (part as ThinkingBlock).streamId === id) as
		| ThinkingBlock
		| undefined;
	if (!block) return;
	if (thinkingSignature) block.thinkingSignature = thinkingSignature;
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
	const namespace = openAICodexMetadata(part.providerMetadata)?.namespace;
	if (typeof namespace === "string") block.namespace = namespace;
	block.time.end = Date.now();
	delete block.partialJson;

	if (!existing) {
		output.parts.push(block);
	}

	const index = partIndex(output, block);
	stream.push({ type: "toolcall.final", partIndex: index, toolCall: block, partial: output });
}

/**
 * Pricing inputs that are only complete once the provider answers.
 *
 * The requested tier is known upfront; the tier actually served and the cache-write
 * breakdown arrive with the terminal usage, and both change what the turn costs.
 */
interface Pricing {
	readonly requestedServiceTier: string | undefined;
	providerMetadata?: unknown;
}

function handlePart(
	part: TextStreamPart<ToolSet>,
	output: Message.AssistantMessage,
	model: Model.Info,
	stream: AssistantMessageEventStream,
	pricing: Pricing,
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
		case "text-end": {
			const messageId = openAICodexMetadata(part.providerMetadata)?.messageId;
			finishTextBlock(output, part.id, stream, typeof messageId === "string" ? messageId : undefined);
			break;
		}
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
		case "reasoning-end": {
			const reasoningItem = openAICodexMetadata(part.providerMetadata)?.reasoningItem;
			const openAISignature = encodeOpenAIReasoningSignature(part.providerMetadata);
			finishThinkingBlock(
				output,
				part.id,
				stream,
				typeof reasoningItem === "string" ? reasoningItem : openAISignature,
			);
			break;
		}
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
			pricing.providerMetadata = part.providerMetadata ?? pricing.providerMetadata;
			output.usage = mapUsage(part.usage, model, resolvePricing(model, pricing), pricing.providerMetadata);
			output.stopReason = mapFinishReason(part.finishReason);
			break;
		case "finish":
			output.usage = mapUsage(part.totalUsage, model, resolvePricing(model, pricing), pricing.providerMetadata);
			output.stopReason = mapFinishReason(part.finishReason);
			break;
		case "abort":
			output.stopReason = "aborted";
			if (part.reason !== undefined) output.errorMessage = part.reason;
			break;
		case "error":
			throw part.error instanceof Error ? part.error : new Error(formatThrownError(part.error));
	}
}

function resolvePricing(model: Model.Info, pricing: Pricing): number {
	return Pricing.serviceTierCostMultiplier(
		model,
		Pricing.servedServiceTier(model, pricing.requestedServiceTier, pricing.providerMetadata),
	);
}

/**
 * The response ceiling to send, already fitted around the thinking budget by
 * {@link Thinking.resolvePlan}.
 *
 * `plan.maxTokens` is the whole response -- thinking and answer together, which is
 * what Anthropic's own `max_tokens` means. But `@ai-sdk/anthropic` treats
 * `maxOutputTokens` as the answer alone and adds the budget back on before sending
 * (`baseArgs.max_tokens = maxTokens + thinkingBudget`). Handing it the total there
 * would ask for the budget twice, so it gets the answer room and reconstructs the
 * total itself.
 *
 * That only applies when a budget is actually sent. An adaptive model is given an
 * effort level and no budget, so the SDK adds nothing and the total goes through
 * unchanged -- subtracting there would quietly under-ask by the whole budget.
 */
export function resolveMaxOutputTokens(model: Model.Info, plan: Thinking.Plan): number | undefined {
	const key = Model.optionsKey(model);
	// The ChatGPT Codex backend rejects max_output_tokens, so never send it.
	if (key === "openai-codex") return undefined;
	if (plan.maxTokens === undefined) return undefined;

	const sendsBudget =
		(key === "anthropic" || key === "google-vertex-anthropic") && !model.compat?.forceAdaptiveThinking;
	return sendsBudget ? plan.maxTokens - plan.budget : plan.maxTokens;
}

export const stream: Protocol.StreamFunction<Model.KnownProviderEnum, typeof Options> = (model, context, options) => {
	const stream = new AssistantMessageEventStream();
	const runtimeOptions = applyDefaultMaxTokens(model, (options ?? {}) as RuntimeOptions);

	void (async () => {
		const output = createAssistantMessage(model);
		try {
			const plan = Thinking.resolvePlan(model, context, runtimeOptions);
			const languageModel = await resolveAISDKLanguageModel(model, runtimeOptions, plan.budget);
			const tools = convertTools(context.tools, model);
			const messages = convertMessages(context, model);
			const providerOptions = resolveProviderOptions(model, runtimeOptions, plan) as Parameters<
				typeof streamText<ToolSet>
			>[0]["providerOptions"];
			const pricing: Pricing = {
				requestedServiceTier: Pricing.requestedServiceTier(
					model,
					runtimeOptions,
					providerOptions as ProviderOptionBag,
				),
			};
			const activeTools = runtimeOptions.activeTools?.filter((name) => !tools || name in tools);

			let params: Parameters<typeof streamText<ToolSet>>[0] = compact({
				model: languageModel,
				system: context.systemPrompt,
				messages,
				tools,
				toolChoice: runtimeOptions.toolChoice as Parameters<typeof streamText<ToolSet>>[0]["toolChoice"],
				activeTools,
				maxOutputTokens: resolveMaxOutputTokens(model, plan),
				temperature: runtimeOptions.temperature,
				providerOptions,
				abortSignal: runtimeOptions.signal,
				timeout: runtimeOptions.timeoutMs,
				maxRetries: runtimeOptions.maxRetries,
				headers: runtimeOptions.headers,
				// Aikit owns error normalization and emits one terminal error event.
				// AI SDK's default callback logs the raw exception (including request
				// payloads) before that event can reach an SDK or CLI consumer.
				onError: () => {},
			});

			const payload = await runtimeOptions.onPayload?.(params, model);
			if (payload !== undefined) {
				params = payload as Parameters<typeof streamText<ToolSet>>[0];
			}

			const result = streamText(params);
			stream.push({ type: "start", partial: output });

			for await (const part of result.fullStream) {
				handlePart(part, output, model, stream, pricing);
			}

			if (runtimeOptions.signal?.aborted || output.stopReason === "aborted") {
				throw new Error(output.errorMessage || "request was aborted");
			}
			if (output.stopReason === "error") {
				throw new Error(output.errorMessage || "provider returned an error stop reason");
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
			if (output.stopReason === "aborted") {
				output.errorMessage = formatThrownError(error);
			} else {
				output.failure = Failure.normalize(error);
				output.errorMessage = output.failure.message;
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};
