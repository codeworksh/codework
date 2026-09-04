import {
	jsonSchema,
	type AssistantModelMessage,
	type FinishReason,
	type LanguageModelUsage,
	type ModelMessage,
	type TextStreamPart,
	type ToolModelMessage,
	type ToolSet,
	type UserModelMessage,
} from "ai";
import * as Message from "../message/message.ts";
import { Pricing } from "./pricing.ts";
import * as Model from "../model/model.ts";
import { resolveOpenAICodexToolConstraint } from "../providers/openai-codex/codex-tools.ts";
import { shortHash } from "../utils/hash.ts";
import { parseStreamingJson } from "../utils/jsonparse.ts";
import { sanitizeSurrogates } from "../utils/sanitize.ts";

type ToolCallPart = Extract<Message.AssistantMessage["parts"][number], { type: "toolCall" }>;
type TerminalToolCall = Exclude<ToolCallPart, Message.ToolCallPendingPart | Message.ToolCallRunningPart>;

export function createAssistantMessage(model: Model.Info): Message.AssistantMessage {
	return Message.createAssistantMessage({
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
}

function userContent(parts: Message.UserMessage["parts"], supportsImages: boolean): ModelMessage[] {
	const content: Exclude<UserModelMessage["content"], string> = [];
	for (const part of parts) {
		if (part.type === "text") {
			const text = sanitizeSurrogates(part.text);
			if (text.trim().length > 0) {
				content.push({ type: "text", text });
			}
			continue;
		}
		if (supportsImages) {
			content.push({ type: "file", data: part.data, mediaType: part.mimeType });
		}
	}

	if (content.length === 0) return [];
	return [{ role: "user", content }];
}

function sanitizeValue(value: unknown): unknown {
	if (typeof value === "string") return sanitizeSurrogates(value);
	if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
	if (typeof value === "object" && value !== null) {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			result[key] = sanitizeValue(item);
		}
		return result;
	}
	return value;
}

function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
	return sanitizeValue(value) as Record<string, unknown>;
}

function toolResultOutput(toolCall: TerminalToolCall) {
	const text = toolCall.result.content
		.filter((content) => content.type === "text")
		.map((content) => sanitizeSurrogates(content.text))
		.join("\n");
	const images = toolCall.result.content.filter((content) => content.type === "image");

	if (toolCall.result.isError) {
		return {
			type: "error-text" as const,
			value: text || "tool returned an error",
		};
	}

	if (images.length === 0) {
		return {
			type: "text" as const,
			value: text,
		};
	}

	return {
		type: "content" as const,
		value: [
			...(text.length > 0 ? [{ type: "text" as const, text }] : []),
			...images.map((image) => ({
				type: "file" as const,
				data: { type: "data" as const, data: image.data },
				mediaType: image.mimeType,
			})),
		],
	};
}

function normalizeOpenAICodexIdPart(value: string): string {
	return value
		.replace(/[^a-zA-Z0-9_-]/g, "_")
		.slice(0, 64)
		.replace(/_+$/, "");
}

export function normalizeOpenAICodexToolCallId(
	id: string,
	model: Model.Info,
	source: Message.AssistantMessage,
): string {
	if (!id.includes("|")) return normalizeOpenAICodexIdPart(id);
	const [callId, itemId = ""] = id.split("|");
	const normalizedCallId = normalizeOpenAICodexIdPart(callId ?? "");
	const isForeignToolCall = source.provider.id !== model.provider.id || source.protocol !== model.protocol;
	let normalizedItemId = isForeignToolCall ? `fc_${shortHash(itemId)}` : normalizeOpenAICodexIdPart(itemId);
	if (!normalizedItemId.startsWith("fc_") && !normalizedItemId.startsWith("ctc_")) {
		normalizedItemId = normalizeOpenAICodexIdPart(`fc_${normalizedItemId}`);
	}
	return `${normalizedCallId}|${normalizedItemId}`;
}

type OpenAIReasoningMetadata = {
	itemId: string;
	reasoningEncryptedContent?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function encodeOpenAIReasoningSignature(providerMetadata: unknown): string | undefined {
	if (!isRecord(providerMetadata)) return;
	const metadata = providerMetadata.openai;
	if (!isRecord(metadata) || typeof metadata.itemId !== "string") return;

	const signature: OpenAIReasoningMetadata = { itemId: metadata.itemId };
	if (typeof metadata.reasoningEncryptedContent === "string" || metadata.reasoningEncryptedContent === null) {
		signature.reasoningEncryptedContent = metadata.reasoningEncryptedContent;
	}
	return JSON.stringify(signature);
}

function decodeOpenAIReasoningSignature(signature: string): OpenAIReasoningMetadata | undefined {
	try {
		const parsed: unknown = JSON.parse(signature);
		if (isRecord(parsed) && typeof parsed.itemId === "string") {
			return {
				itemId: parsed.itemId,
				...(typeof parsed.reasoningEncryptedContent === "string" || parsed.reasoningEncryptedContent === null
					? { reasoningEncryptedContent: parsed.reasoningEncryptedContent }
					: {}),
			};
		}
	} catch {
		return;
	}
}

function assistantMessages(message: Message.AssistantMessage, model: Model.Info): ModelMessage[] {
	if (message.stopReason === "error" || message.stopReason === "aborted") return [];

	const assistantContent: Exclude<AssistantModelMessage["content"], string> = [];
	const toolResults: ToolModelMessage["content"] = [];

	for (const part of message.parts) {
		if (part.type === "text") {
			const text = sanitizeSurrogates(part.text);
			if (text.trim().length === 0) continue;
			assistantContent.push({
				type: "text",
				text,
				...(part.textSignature && message.protocol === Model.KnownProviderEnum.openaiCodex
					? { providerOptions: { "openai-codex": { messageId: part.textSignature } } }
					: {}),
			});
			continue;
		}
		if (part.type === "thinking") {
			const thinking = sanitizeSurrogates(part.thinking);
			if (thinking.trim().length === 0 && !part.thinkingSignature) continue;
			const reasoning: Record<string, unknown> = { type: "reasoning", text: thinking };
			// OpenAI Responses only accepts native reasoning items with encoded metadata.
			if (message.protocol === Model.KnownProviderEnum.openai) {
				if (!part.thinkingSignature) continue;
				const openai = decodeOpenAIReasoningSignature(part.thinkingSignature);
				if (!openai) continue;
				reasoning.providerOptions = { openai };
			} else if (part.thinkingSignature) {
				reasoning.providerOptions =
					message.protocol === Model.KnownProviderEnum.openaiCodex
						? { "openai-codex": { reasoningItem: part.thinkingSignature } }
						: { anthropic: { signature: part.thinkingSignature } };
			}
			assistantContent.push(reasoning as (typeof assistantContent)[number]);
			continue;
		}
		if (part.type !== "toolCall") continue;

		const codexToolMetadata: { namespace?: string; omitItemId?: boolean } = {};
		if (part.namespace && message.protocol === Model.KnownProviderEnum.openaiCodex) {
			codexToolMetadata.namespace = part.namespace;
		}
		if (
			model.protocol === Model.KnownProviderEnum.openaiCodex &&
			message.protocol === model.protocol &&
			message.provider.id === model.provider.id &&
			message.model !== model.id
		) {
			codexToolMetadata.omitItemId = true;
		}
		assistantContent.push({
			type: "tool-call",
			toolCallId: part.callID,
			toolName: part.name,
			input: sanitizeRecord(part.arguments ?? {}),
			...(Object.keys(codexToolMetadata).length > 0
				? { providerOptions: { "openai-codex": codexToolMetadata } }
				: {}),
		});

		const terminal = part.status === "pending" || part.status === "running" ? undefined : part;
		toolResults.push({
			type: "tool-result",
			toolCallId: part.callID,
			toolName: part.name,
			...(terminal?.addedToolNames?.length
				? { providerOptions: { "openai-codex": { addedToolNames: terminal.addedToolNames } } }
				: {}),
			output: terminal
				? toolResultOutput(terminal)
				: {
						type: "error-text",
						value: "no result provided",
					},
		});
	}

	const result: ModelMessage[] = [];
	if (assistantContent.length > 0) {
		result.push({ role: "assistant", content: assistantContent });
	}
	if (toolResults.length > 0) {
		result.push({ role: "tool", content: toolResults });
	}
	return result;
}

export function convertMessages(context: Message.Context, model: Model.Info): ModelMessage[] {
	const messages: ModelMessage[] = [];
	const transformedMessages = Message.transformMessages(
		context.messages,
		model,
		model.protocol === Model.KnownProviderEnum.openaiCodex ? normalizeOpenAICodexToolCallId : undefined,
	);

	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			messages.push(...userContent(msg.parts, model.input.includes("image")));
			continue;
		}
		messages.push(...assistantMessages(msg, model));
	}

	return messages;
}

export function convertTools(tools?: Message.Tool[], model?: Model.Info): ToolSet | undefined {
	if (!tools || tools.length === 0) return;

	const result: ToolSet = {};
	for (const tool of tools) {
		const jsonSchemaConstraint = Message.resolveJsonSchemaConstraint(tool, model?.compat);
		const grammarConstraint =
			model?.protocol === Model.KnownProviderEnum.openaiCodex
				? resolveOpenAICodexToolConstraint(tool, model.compat)
				: undefined;
		result[tool.name] = {
			description: tool.description,
			inputSchema: jsonSchema(tool.parameters as any),
			...(jsonSchemaConstraint ? { strict: true } : {}),
			...(grammarConstraint?.type === "grammar"
				? { providerOptions: { "openai-codex": { grammar: grammarConstraint } } }
				: {}),
		};
	}
	return result;
}

export function mapFinishReason(reason: FinishReason | undefined): Message.StopReason {
	switch (reason) {
		case "length":
			return "length";
		case "tool-calls":
			return "toolUse";
		case "content-filter":
		case "error":
		case "other":
			return "error";
		case "stop":
		default:
			return "stop";
	}
}

export function mapUsage(
	usage: LanguageModelUsage | undefined,
	model: Model.Info,
	costMultiplier = 1,
	providerMetadata?: unknown,
): Message.AssistantMessage["usage"] {
	const cacheRead = usage?.inputTokenDetails.cacheReadTokens ?? 0;
	const cacheWrite = usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
	const cacheWrite1h = Pricing.cacheWrite1hTokens(providerMetadata);
	const input =
		usage?.inputTokenDetails?.noCacheTokens ?? Math.max((usage?.inputTokens ?? 0) - cacheRead - cacheWrite, 0);
	const output = usage?.outputTokens ?? 0;
	const totalTokens = usage?.totalTokens ?? input + cacheRead + cacheWrite + output;
	const result: Message.AssistantMessage["usage"] = {
		input,
		output,
		cacheRead,
		cacheWrite,
		...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
		...(usage?.outputTokenDetails?.reasoningTokens !== undefined
			? { reasoning: usage.outputTokenDetails.reasoningTokens }
			: {}),
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	Model.calculateCost(model, result);
	if (costMultiplier !== 1) {
		result.cost.input *= costMultiplier;
		result.cost.output *= costMultiplier;
		result.cost.cacheRead *= costMultiplier;
		result.cost.cacheWrite *= costMultiplier;
		result.cost.total = result.cost.input + result.cost.output + result.cost.cacheRead + result.cost.cacheWrite;
	}
	return result;
}

export type StreamingToolCallBlock = Message.ToolCallPendingPart & {
	partialJson?: string;
};

export function toolCallFromPart(
	part: Extract<TextStreamPart<ToolSet>, { type: "tool-call" }>,
): StreamingToolCallBlock {
	return {
		type: "toolCall",
		callID: part.toolCallId,
		name: part.toolName,
		arguments: typeof part.input === "object" && part.input !== null ? (part.input as Record<string, unknown>) : {},
		status: "pending",
		time: {
			start: Date.now(),
			end: Date.now(),
		},
	};
}

export function updateToolCallFromInput(block: StreamingToolCallBlock, partialJson: string): void {
	block.partialJson = partialJson;
	block.arguments = parseStreamingJson<Record<string, unknown>>(partialJson);
	block.time.end = Date.now();
}
