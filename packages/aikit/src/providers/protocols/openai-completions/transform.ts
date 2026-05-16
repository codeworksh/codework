import { Model } from "../../../model/model";
import { Message } from "../../../message/message";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionMessageParam,
	ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import { sanitizeSurrogates } from "../../../utils/sanitize";
import type { ModelFlag } from "../../../model/flag";

function buildSyntheticToolResult(
	block: Extract<Message.ToolCall, { status: "pending" | "running" }>,
): ChatCompletionToolMessageParam {
	const message: ChatCompletionToolMessageParam = {
		role: "tool",
		content: ["<result>", "No Result Provided", "</result>"].join("\n"),
		tool_call_id: block.callID,
	};
	return message;
}

export function convertMessages<
	TProtocol extends Model.KnownProtocolEnum = typeof Model.KnownProtocolEnum.openaiCompletions,
>(context: Message.Context, model: Model.TModel<TProtocol>): ChatCompletionMessageParam[] {
	const params: ChatCompletionMessageParam[] = [];
	const compat = model.compat as ModelFlag.OpenAICompletionsCompat;

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

		if (model.provider.id === Model.KnownProviderEnum.openai) {
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
					assistantMsg as ChatCompletionAssistantMessageParam & {
						reasoning_details?: unknown[];
					}
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

		const imageBlocks: Array<{
			type: "image_url";
			image_url: { url: string };
		}> = [];

		for (const toolCall of toolCalls) {
			if (toolCall.status === "pending" || toolCall.status === "running") {
				params.push(buildSyntheticToolResult(toolCall));
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
