import type {
	LanguageModelV3FilePart,
	LanguageModelV3Prompt,
	LanguageModelV3ToolResultOutput,
	LanguageModelV4FilePart,
	LanguageModelV4Prompt,
	LanguageModelV4ToolResultOutput,
} from "@ai-sdk/provider";
import { shortHash } from "../../utils/hash.ts";
import type { OpenAICodexDeferredToolsMode, OpenAICodexTool } from "./codex-tools.ts";

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
			id?: string;
			call_id: string;
			name: string;
			arguments: string;
			namespace?: string;
	  }
	| {
			type: "custom_tool_call";
			id?: string;
			call_id: string;
			name: string;
			input: string;
			namespace?: string;
	  }
	| {
			type: "reasoning";
			id: string;
			[key: string]: unknown;
	  }
	| {
			type: "function_call_output";
			call_id: string;
			output:
				| string
				| Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "auto" }>;
	  }
	| {
			type: "custom_tool_call_output";
			call_id: string;
			output: string;
	  }
	| {
			type: "additional_tools";
			role: "developer";
			tools: OpenAICodexTool[];
	  }
	| {
			type: "tool_search_call";
			call_id: string;
			execution: "client";
			status: "completed";
			arguments: { query: string; limit: number };
	  }
	| {
			type: "tool_search_output";
			call_id: string;
			execution: "client";
			status: "completed";
			tools: OpenAICodexTool[];
	  };

export type OpenAICodexPrompt = {
	instructions: string;
	input: OpenAICodexInputItem[];
};

const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

export type OpenAICodexPromptOptions = {
	deferredTools?: ReadonlyMap<string, OpenAICodexTool>;
	deferredToolsMode?: OpenAICodexDeferredToolsMode;
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	supportsImages?: boolean;
};

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

function imageUrlFromFilePart(part: LanguageModelV3FilePart | LanguageModelV4FilePart): string | undefined {
	const data = part.data;
	if (data instanceof URL) return data.toString();
	if (typeof data === "string") {
		if (data.startsWith("data:") || data.startsWith("http://") || data.startsWith("https://")) return data;
		return `data:${part.mediaType};base64,${data}`;
	}
	if (data instanceof Uint8Array) {
		return `data:${part.mediaType};base64,${uint8ArrayToBase64(data)}`;
	}
	if ("type" in data) {
		if (data.type === "url") return data.url.toString();
		if (data.type === "data") {
			return typeof data.data === "string"
				? `data:${part.mediaType};base64,${data.data}`
				: `data:${part.mediaType};base64,${uint8ArrayToBase64(data.data)}`;
		}
	}
	return undefined;
}

function toolResultOutput(
	output: LanguageModelV3ToolResultOutput | LanguageModelV4ToolResultOutput,
	supportsImages: boolean,
): Extract<OpenAICodexInputItem, { type: "function_call_output" }>["output"] {
	switch (output.type) {
		case "text":
		case "error-text":
			return output.value || "(no tool output)";
		case "json":
		case "error-json":
			return JSON.stringify(output.value);
		case "execution-denied":
			return output.reason ?? "Tool execution denied";
		case "content": {
			const text = output.value
				.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			const images: Array<{ type: "input_image"; image_url: string; detail: "auto" }> = [];
			if (supportsImages) {
				for (const part of output.value) {
					if (part.type === "file-data" && part.mediaType.startsWith("image/")) {
						images.push({
							type: "input_image",
							image_url: `data:${part.mediaType};base64,${part.data}`,
							detail: "auto",
						});
					} else if (part.type === "file-url") {
						images.push({ type: "input_image", image_url: part.url, detail: "auto" });
					} else if (part.type === "file" && part.mediaType.startsWith("image/")) {
						const data = part.data;
						if (data.type === "url") {
							images.push({ type: "input_image", image_url: data.url.toString(), detail: "auto" });
						} else if (data.type === "data") {
							const encoded = typeof data.data === "string" ? data.data : uint8ArrayToBase64(data.data);
							images.push({
								type: "input_image",
								image_url: `data:${part.mediaType};base64,${encoded}`,
								detail: "auto",
							});
						}
					}
				}
			}
			if (images.length === 0)
				return text || (output.value.length > 0 ? "(see attached image)" : "(no tool output)");
			return [...(text ? [{ type: "input_text" as const, text }] : []), ...images];
		}
		default:
			return JSON.stringify(output);
	}
}

function customToolInput(input: unknown, toolName: string, inputProperty: string): string {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new Error(`Custom tool "${toolName}" requires object input with string property "${inputProperty}".`);
	}
	const value = (input as Record<string, unknown>)[inputProperty];
	if (typeof value !== "string") {
		throw new Error(`Custom tool "${toolName}" requires string input property "${inputProperty}".`);
	}
	return value;
}

function customToolOutput(
	output: LanguageModelV3ToolResultOutput | LanguageModelV4ToolResultOutput,
	supportsImages: boolean,
): string {
	const value = toolResultOutput(output, supportsImages);
	return typeof value === "string" ? value : JSON.stringify(value);
}

function codexProviderMetadata(
	providerOptions: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	const codex = providerOptions?.["openai-codex"];
	return typeof codex === "object" && codex !== null && !Array.isArray(codex)
		? (codex as Record<string, unknown>)
		: undefined;
}

function addedToolNames(providerOptions: Record<string, unknown> | undefined): string[] {
	const names = codexProviderMetadata(providerOptions)?.addedToolNames;
	return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
}

function reasoningItem(
	providerOptions: Record<string, unknown> | undefined,
): Extract<OpenAICodexInputItem, { type: "reasoning" }> | undefined {
	const value = codexProviderMetadata(providerOptions)?.reasoningItem;
	if (typeof value !== "string") return undefined;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		const item = parsed as Record<string, unknown>;
		return item.type === "reasoning" && typeof item.id === "string"
			? (item as Extract<OpenAICodexInputItem, { type: "reasoning" }>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Collect definitions that were introduced at a transcript load point rather than at request start. */
export function collectOpenAICodexDeferredToolNames(
	prompt: LanguageModelV3Prompt | LanguageModelV4Prompt,
): Set<string> {
	const deferredNames = new Set<string>();
	const usedNames = new Set<string>();

	for (const message of prompt) {
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "tool-call") usedNames.add(part.toolName);
				if (part.type === "tool-result") {
					for (const name of addedToolNames(part.providerOptions)) {
						if (!usedNames.has(name)) deferredNames.add(name);
					}
				}
			}
			continue;
		}
		if (message.role !== "tool") continue;
		for (const part of message.content) {
			if (part.type !== "tool-result") continue;
			for (const name of addedToolNames(part.providerOptions)) {
				if (!usedNames.has(name)) deferredNames.add(name);
			}
		}
	}

	return deferredNames;
}

function deferredToolCallId(toolCallId: string, names: readonly string[]): string {
	return `aikit_tool_load_${shortHash(`${toolCallId}:${names.join(",")}`)}`;
}

/**
 * Convert an AI SDK V3 prompt into the Codex Responses request shape.
 * System messages become `instructions`; everything else maps to `input` items.
 */
export function convertToOpenAICodexPrompt(
	prompt: LanguageModelV3Prompt | LanguageModelV4Prompt,
	options?: OpenAICodexPromptOptions,
): OpenAICodexPrompt {
	let instructions: string | undefined;
	const input: OpenAICodexInputItem[] = [];
	let syntheticMessageCounter = 0;
	const loadedToolNames = new Set<string>();

	const appendDeferredTools = (toolCallId: string, names: readonly string[]): void => {
		const tools: OpenAICodexTool[] = [];
		for (const name of names) {
			const tool = options?.deferredTools?.get(name);
			if (!tool || loadedToolNames.has(name)) continue;
			loadedToolNames.add(name);
			tools.push(tool);
		}
		if (tools.length === 0) return;

		if (options?.deferredToolsMode === "additional-tools") {
			input.push({ type: "additional_tools", role: "developer", tools });
			return;
		}
		if (options?.deferredToolsMode === "tool-search") {
			const callId = deferredToolCallId(
				toolCallId,
				tools.map((tool) => tool.name),
			);
			input.push({
				type: "tool_search_call",
				call_id: callId,
				execution: "client",
				status: "completed",
				arguments: { query: tools.map((tool) => tool.name).join(" "), limit: tools.length },
			});
			input.push({
				type: "tool_search_output",
				call_id: callId,
				execution: "client",
				status: "completed",
				tools: tools.map((tool) => ({ ...tool, defer_loading: true })),
			});
		}
	};

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
				for (const part of message.content) {
					if (part.type === "reasoning") {
						const item = reasoningItem(part.providerOptions);
						if (item) input.push(item);
					} else if (part.type === "text") {
						syntheticMessageCounter++;
						const messageId = codexProviderMetadata(part.providerOptions)?.messageId;
						input.push({
							type: "message",
							role: "assistant",
							id:
								typeof messageId === "string" && messageId.length <= 64
									? messageId
									: `msg_aikit_${syntheticMessageCounter}`,
							content: [{ type: "output_text", text: part.text, annotations: [] }],
							status: "completed",
						});
					} else if (part.type === "tool-call") {
						const { callId, itemId } = splitToolCallId(part.toolCallId);
						const metadata = codexProviderMetadata(part.providerOptions);
						const namespace = metadata?.namespace;
						const inputProperty = options?.grammarToolInputProperties?.get(part.toolName);
						if (inputProperty) {
							input.push({
								type: "custom_tool_call",
								...(metadata?.omitItemId === true || !itemId.startsWith("ctc_") ? {} : { id: itemId }),
								call_id: callId,
								name: part.toolName,
								input: customToolInput(part.input, part.toolName, inputProperty),
								...(typeof namespace === "string" ? { namespace } : {}),
							});
						} else {
							input.push({
								type: "function_call",
								...(metadata?.omitItemId === true || !itemId.startsWith("fc_") ? {} : { id: itemId }),
								call_id: callId,
								name: part.toolName,
								arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {}),
								...(typeof namespace === "string" ? { namespace } : {}),
							});
						}
					}
				}
				break;
			}

			case "tool": {
				for (const part of message.content) {
					if (part.type !== "tool-result") continue;
					const { callId } = splitToolCallId(part.toolCallId);
					if (options?.grammarToolInputProperties?.has(part.toolName)) {
						input.push({
							type: "custom_tool_call_output",
							call_id: callId,
							output: customToolOutput(part.output, options?.supportsImages ?? true),
						});
					} else {
						input.push({
							type: "function_call_output",
							call_id: callId,
							output: toolResultOutput(part.output, options?.supportsImages ?? true),
						});
					}
					appendDeferredTools(part.toolCallId, addedToolNames(part.providerOptions));
				}
				break;
			}
		}
	}

	return { instructions: instructions || DEFAULT_INSTRUCTIONS, input };
}
