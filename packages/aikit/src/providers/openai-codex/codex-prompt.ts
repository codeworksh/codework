import type { LanguageModelV3FilePart, LanguageModelV3Prompt, LanguageModelV3ToolResultOutput } from "@ai-sdk/provider";

/**
 * OpenAI Responses API input item types accepted by the Codex backend.
 */
export type OpenAICodexInputItem =
	| {
			role: "user";
			content: Array<
				{ type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail?: string }
			>;
	  }
	| {
			type: "message";
			role: "assistant";
			id: string;
			content: Array<{ type: "output_text"; text: string; annotations: unknown[] }>;
			status: "completed";
	  }
	| {
			type: "function_call";
			id: string;
			call_id: string;
			name: string;
			arguments: string;
	  }
	| {
			type: "function_call_output";
			call_id: string;
			output: string;
	  };

export type OpenAICodexPrompt = {
	instructions: string;
	input: OpenAICodexInputItem[];
};

const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

// Tool call ids round-trip through the AI SDK as `call_id|item_id` because the
// Responses API needs both halves: `call_id` to pair function_call_output and
// `id` for the function_call item itself.
export function splitToolCallId(toolCallId: string): { callId: string; itemId: string } {
	const separator = toolCallId.indexOf("|");
	if (separator === -1) return { callId: toolCallId, itemId: toolCallId };
	return { callId: toolCallId.slice(0, separator), itemId: toolCallId.slice(separator + 1) };
}

export function joinToolCallId(callId: string, itemId: string): string {
	return `${callId}|${itemId}`;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function imageUrlFromFilePart(part: LanguageModelV3FilePart): string | undefined {
	const data = part.data;
	if (data instanceof URL) return data.toString();
	if (typeof data === "string") {
		if (data.startsWith("data:") || data.startsWith("http://") || data.startsWith("https://")) return data;
		return `data:${part.mediaType};base64,${data}`;
	}
	if (data instanceof Uint8Array) {
		return `data:${part.mediaType};base64,${uint8ArrayToBase64(data)}`;
	}
	return undefined;
}

function toolResultOutputToText(output: LanguageModelV3ToolResultOutput): string {
	switch (output.type) {
		case "text":
		case "error-text":
			return output.value;
		case "json":
		case "error-json":
			return JSON.stringify(output.value);
		case "execution-denied":
			return output.reason ?? "Tool execution denied";
		case "content":
			return output.value
				.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
				.map((part) => part.text)
				.join("\n");
		default:
			return JSON.stringify(output);
	}
}

/**
 * Convert an AI SDK V3 prompt into the Codex Responses request shape.
 * System messages become `instructions`; everything else maps to `input` items.
 */
export function convertToOpenAICodexPrompt(prompt: LanguageModelV3Prompt): OpenAICodexPrompt {
	let instructions: string | undefined;
	const input: OpenAICodexInputItem[] = [];
	let syntheticMessageCounter = 0;

	for (const message of prompt) {
		switch (message.role) {
			case "system": {
				instructions = instructions == null ? message.content : `${instructions}\n\n${message.content}`;
				break;
			}

			case "user": {
				const content: Extract<OpenAICodexInputItem, { role: "user" }>["content"] = [];
				for (const part of message.content) {
					if (part.type === "text") {
						content.push({ type: "input_text", text: part.text });
					} else if (part.type === "file" && part.mediaType.startsWith("image/")) {
						const imageUrl = imageUrlFromFilePart(part);
						if (imageUrl) content.push({ type: "input_image", image_url: imageUrl, detail: "auto" });
					}
				}
				if (content.length > 0) {
					input.push({ role: "user", content });
				}
				break;
			}

			case "assistant": {
				const textParts: string[] = [];
				for (const part of message.content) {
					if (part.type === "text") {
						textParts.push(part.text);
					} else if (part.type === "tool-call") {
						const { callId, itemId } = splitToolCallId(part.toolCallId);
						input.push({
							type: "function_call",
							id: itemId,
							call_id: callId,
							name: part.toolName,
							arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {}),
						});
					}
					// Reasoning parts are not replayed: the Codex backend regenerates
					// reasoning server-side and rejects unsigned reasoning items.
				}
				if (textParts.length > 0) {
					syntheticMessageCounter++;
					input.push({
						type: "message",
						role: "assistant",
						id: `msg_${Date.now()}_${syntheticMessageCounter}`,
						content: [{ type: "output_text", text: textParts.join("\n"), annotations: [] }],
						status: "completed",
					});
				}
				break;
			}

			case "tool": {
				for (const part of message.content) {
					if (part.type !== "tool-result") continue;
					const { callId } = splitToolCallId(part.toolCallId);
					input.push({
						type: "function_call_output",
						call_id: callId,
						output: toolResultOutputToText(part.output),
					});
				}
				break;
			}
		}
	}

	return { instructions: instructions || DEFAULT_INSTRUCTIONS, input };
}
