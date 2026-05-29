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
import { Message } from "../message/message";
import { Model } from "../model/model";
import { parseStreamingJson } from "../utils/jsonparse";
import { sanitizeSurrogates } from "../utils/sanitize";

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
			content.push({ type: "image", image: part.data, mediaType: part.mimeType });
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
			value: text || "Tool returned an error",
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
				type: "image-data" as const,
				data: image.data,
				mediaType: image.mimeType,
			})),
		],
	};
}

function assistantMessages(message: Message.AssistantMessage): ModelMessage[] {
	if (message.stopReason === "error" || message.stopReason === "aborted") return [];

	const assistantContent: Exclude<AssistantModelMessage["content"], string> = [];
	const toolResults: ToolModelMessage["content"] = [];

	for (const part of message.parts) {
		if (part.type === "text") {
			const text = sanitizeSurrogates(part.text);
			if (text.trim().length === 0) continue;
			assistantContent.push({ type: "text", text });
			continue;
		}
		if (part.type === "thinking") {
			const thinking = sanitizeSurrogates(part.thinking);
			if (thinking.trim().length === 0) continue;
			const reasoning: Record<string, unknown> = { type: "reasoning", text: thinking };
			// Include the provider signature for faithful replay (e.g. Anthropic extended thinking).
			if (part.thinkingSignature) {
				reasoning.providerOptions = {
					anthropic: { signature: part.thinkingSignature },
				};
			}
			assistantContent.push(reasoning as (typeof assistantContent)[number]);
			continue;
		}
		if (part.type !== "toolCall") continue;

		assistantContent.push({
			type: "tool-call",
			toolCallId: part.callID,
			toolName: part.name,
			input: sanitizeRecord(part.arguments ?? {}),
		});

		const terminal = part.status === "pending" || part.status === "running" ? undefined : part;
		toolResults.push({
			type: "tool-result",
			toolCallId: part.callID,
			toolName: part.name,
			output: terminal
				? toolResultOutput(terminal)
				: {
						type: "error-text",
						value: "No result provided",
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
	const transformedMessages = Message.transformMessages(context.messages, model);

	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			messages.push(...userContent(msg.parts, model.input.includes("image")));
			continue;
		}
		messages.push(...assistantMessages(msg));
	}

	return messages;
}

export function convertTools(tools?: Message.Tool[]): ToolSet | undefined {
	if (!tools || tools.length === 0) return;

	const result: ToolSet = {};
	for (const tool of tools) {
		result[tool.name] = {
			description: tool.description,
			inputSchema: jsonSchema(tool.parameters as any),
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

export function mapUsage(usage: LanguageModelUsage | undefined, model: Model.Info): Message.AssistantMessage["usage"] {
	const cacheRead = usage?.inputTokenDetails?.cacheReadTokens ?? usage?.cachedInputTokens ?? 0;
	const cacheWrite = usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
	const input =
		usage?.inputTokenDetails?.noCacheTokens ?? Math.max((usage?.inputTokens ?? 0) - cacheRead - cacheWrite, 0);
	const output = usage?.outputTokens ?? 0;
	const totalTokens = usage?.totalTokens ?? input + cacheRead + cacheWrite + output;
	const result: Message.AssistantMessage["usage"] = {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	Model.calculateCost(model, result);
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
