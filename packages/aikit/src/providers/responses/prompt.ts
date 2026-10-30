import type {
	LanguageModelV3FilePart,
	LanguageModelV3Prompt,
	LanguageModelV3ToolResultOutput,
	LanguageModelV4FilePart,
	LanguageModelV4Prompt,
	LanguageModelV4ToolResultOutput,
} from "@ai-sdk/provider";
import { shortHash } from "../../utils/hash.ts";
import { toResponsesTool, type ResponsesTool, type ResponsesToolChange } from "./tools.ts";

/**
 * OpenAI Responses API input item types this transport sends.
 */
export type ResponsesInputItem =
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
			role: "developer";
			content: string;
	  }
	| {
			type: "additional_tools";
			role: "developer";
			tools: ResponsesTool[];
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
			tools: ResponsesTool[];
	  };

export type ResponsesPrompt = {
	/** The system prompt, when it travels in the `instructions` field. */
	instructions?: string;
	input: ResponsesInputItem[];
};

const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

export type ResponsesPromptOptions = {
	/** The providerOptions key this transport reads, e.g. `openai-codex`. */
	provider: string;
	/**
	 * Where the leading system prompt goes: the `instructions` field (the Codex backend
	 * requires one), or a developer message in place.
	 */
	systemPrompt: "instructions" | "developer";
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
): Extract<ResponsesInputItem, { type: "function_call_output" }>["output"] {
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
		throw new Error(`custom tool "${toolName}" requires object input with string property "${inputProperty}".`);
	}
	const value = (input as Record<string, unknown>)[inputProperty];
	if (typeof value !== "string") {
		throw new Error(`custom tool "${toolName}" requires string input property "${inputProperty}".`);
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

function providerMetadata(
	providerOptions: Record<string, unknown> | undefined,
	provider: string,
): Record<string, unknown> | undefined {
	const metadata = providerOptions?.[provider];
	return typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
		? (metadata as Record<string, unknown>)
		: undefined;
}

function toolChange(
	providerOptions: Record<string, unknown> | undefined,
	provider: string,
): ResponsesToolChange | undefined {
	return providerMetadata(providerOptions, provider)?.toolChange as ResponsesToolChange | undefined;
}

function reasoningItem(
	providerOptions: Record<string, unknown> | undefined,
	provider: string,
): Extract<ResponsesInputItem, { type: "reasoning" }> | undefined {
	const value = providerMetadata(providerOptions, provider)?.reasoningItem;
	if (typeof value !== "string") return undefined;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		const item = parsed as Record<string, unknown>;
		return item.type === "reasoning" && typeof item.id === "string"
			? (item as Extract<ResponsesInputItem, { type: "reasoning" }>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Names of every tool declared in place by a system message's tool change. */
export function collectInPlaceToolNames(
	prompt: LanguageModelV3Prompt | LanguageModelV4Prompt,
	provider: string,
): Set<string> {
	const names = new Set<string>();
	for (const message of prompt) {
		if (message.role !== "system") continue;
		for (const tool of toolChange(message.providerOptions, provider)?.tools ?? []) names.add(tool.name);
	}
	return names;
}

/*
 * `additional_tools` items accumulate: a later item adds tools and replaces same-name
 * definitions from earlier ones, but cannot remove any. Without this notice, models read the
 * latest item as the complete tool set once a removal was announced, and restating the tools
 * that are still unavailable keeps smaller models from calling them after later loads.
 */
function incrementalToolsNotice(unavailable: ReadonlySet<string>): string {
	const notice =
		"This is an incremental tools update. Previously declared tools remain available unless explicitly marked unavailable. A tool declared again here is available again, and its latest definition replaces the earlier one.";
	return unavailable.size > 0 ? `${notice}\nStill unavailable: ${[...unavailable].join(", ")}.` : notice;
}

function toolRemovalNotice(names: readonly string[]): string {
	return `The following tools are no longer available. Do not call them:\n${names.map((name) => `- ${name}`).join("\n")}`;
}

/**
 * Convert an AI SDK V3 prompt into the Responses request shape. The leading system
 * message goes where `options.systemPrompt` says, later ones (prompt updates and tool
 * changes) go in place, and everything else maps to `input` items.
 */
export function convertToResponsesPrompt(
	prompt: LanguageModelV3Prompt | LanguageModelV4Prompt,
	options: ResponsesPromptOptions,
): ResponsesPrompt {
	const { provider } = options;
	let instructions: string | undefined;
	const input: ResponsesInputItem[] = [];
	let syntheticMessageCounter = 0;
	let toolChangeCounter = 0;
	let declaredAdditionalTools = false;
	/** Tools announced as removed and not declared again since. */
	const unavailableTools = new Set<string>();

	/** Declares the change's tools; returns the removal notice, which goes with the message's text. */
	const appendToolChange = (change: ResponsesToolChange): string | undefined => {
		const seed = toolChangeCounter++;
		const tools = change.tools.map((tool) => toResponsesTool(tool, provider));
		for (const tool of tools) unavailableTools.delete(tool.name);
		if (tools.length > 0 && change.mode === "changes") {
			if (declaredAdditionalTools) {
				input.push({ role: "developer", content: incrementalToolsNotice(unavailableTools) });
			}
			declaredAdditionalTools = true;
			input.push({ type: "additional_tools", role: "developer", tools });
		} else if (tools.length > 0) {
			const names = tools.map((tool) => tool.name);
			const callId = `cdwrk_aikit_tool_${shortHash(`${seed}:${names.join(",")}`)}`;
			input.push({
				type: "tool_search_call",
				call_id: callId,
				execution: "client",
				status: "completed",
				arguments: { query: names.join(" "), limit: names.length },
			});
			input.push({
				type: "tool_search_output",
				call_id: callId,
				execution: "client",
				status: "completed",
				tools: tools.map((tool) => ({ ...tool, defer_loading: true })),
			});
		}
		// A redefinition is a removal plus an addition of the same name; only true removals are announced.
		const added = new Set(tools.map((tool) => tool.name));
		const removed = change.removed.filter((name) => !added.has(name));
		if (removed.length === 0) return;
		// Recorded after this change's additions, whose notice precedes this removal notice.
		for (const name of removed) unavailableTools.add(name);
		return toolRemovalNotice(removed);
	};

	for (const message of prompt) {
		switch (message.role) {
			case "system": {
				const change = toolChange(message.providerOptions, provider);
				// The first plain system message is the leading prompt; every later one is an update in place.
				if (!change && options.systemPrompt === "instructions" && instructions === undefined) {
					instructions = message.content;
					break;
				}
				const removal = change ? appendToolChange(change) : undefined;
				const text = [message.content, removal ?? ""].filter((part) => part.length > 0).join("\n\n");
				if (text.length > 0) input.push({ role: "developer", content: text });
				break;
			}

			case "user": {
				const content: Extract<ResponsesInputItem, { role: "user" }>["content"] = [];
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
						const item = reasoningItem(part.providerOptions, provider);
						if (item) input.push(item);
					} else if (part.type === "text") {
						syntheticMessageCounter++;
						const messageId = providerMetadata(part.providerOptions, provider)?.messageId;
						input.push({
							type: "message",
							role: "assistant",
							id:
								typeof messageId === "string" && messageId.length <= 64
									? messageId
									: `msg_cdwrk_aikit_${syntheticMessageCounter}`,
							content: [{ type: "output_text", text: part.text, annotations: [] }],
							status: "completed",
						});
					} else if (part.type === "tool-call") {
						const { callId, itemId } = splitToolCallId(part.toolCallId);
						const metadata = providerMetadata(part.providerOptions, provider);
						const namespace = metadata?.namespace;
						const inputProperty = options.grammarToolInputProperties?.get(part.toolName);
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
					if (options.grammarToolInputProperties?.has(part.toolName)) {
						input.push({
							type: "custom_tool_call_output",
							call_id: callId,
							output: customToolOutput(part.output, options.supportsImages ?? true),
						});
					} else {
						input.push({
							type: "function_call_output",
							call_id: callId,
							output: toolResultOutput(part.output, options.supportsImages ?? true),
						});
					}
				}
				break;
			}
		}
	}

	if (options.systemPrompt === "developer") return { input };
	return { instructions: instructions || DEFAULT_INSTRUCTIONS, input };
}
