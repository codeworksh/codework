import type Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
import { Message } from "../../../message/message";
import { Model } from "../../../model/model";
import { sanitizeSurrogates } from "../../../utils/sanitize";
import type { CacheRetention } from "../../schema/options";
import type { CacheControl } from "./options";

function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (typeof process !== "undefined" && process.env.CODEWORK_CACHE_RETENTION === "long") {
		return "long";
	}
	return "short";
}

export function getCacheControl(baseUrl: string, cache?: CacheRetention): CacheControl | undefined {
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

export function convertMessages<
	TProtocol extends Model.KnownProtocolEnum = typeof Model.KnownProtocolEnum.anthropicMessages,
>(messages: Message.Message[], model: Model.TModel<TProtocol>, cacheControl?: CacheControl): MessageParam[] {
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

export function convertTools(tools: Message.Tool[]): Anthropic.Messages.Tool[] {
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
