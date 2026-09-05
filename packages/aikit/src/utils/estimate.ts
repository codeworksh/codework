/*
 * @file Cheap, provider-independent estimate of how much context a request carries.
 *
 * Used to size a response ceiling before the request goes out, so a long session
 * asks for an answer that still fits rather than taking a provider overflow error.
 * The estimate is deliberately coarse: where a real token count already exists --
 * the usage reported by the last assistant turn -- it is trusted, and only the
 * messages appended after it are estimated.
 */

import type * as Message from "../message/message.ts";

/** Rough characters-per-token ratio across the tokenizers in use. */
const CHARS_PER_TOKEN = 4;
/** A base64 image costs far more than its own text length; this is a flat stand-in. */
const ESTIMATED_IMAGE_CHARS = 4800;

export interface ContextUsageEstimate {
	/** Estimated total context tokens. */
	tokens: number;
	/** Tokens reported by the most recent applicable assistant usage block. */
	usageTokens: number;
	/** Estimated tokens after the most recent applicable assistant usage block. */
	trailingTokens: number;
	/** Index of the applicable message that provided usage, or null when none exists. */
	lastUsageIndex: number | null;
}

export function calculateContextTokens(usage: Message.Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function contentChars(content: ReadonlyArray<Message.TextContent | Message.ImageContent>): number {
	let chars = 0;
	for (const block of content) chars += block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS;
	return chars;
}

export function estimateContentTokens(content: ReadonlyArray<Message.TextContent | Message.ImageContent>): number {
	return Math.ceil(contentChars(content) / CHARS_PER_TOKEN);
}

/**
 * A tool call costs its name, its arguments, and -- unlike providers that carry
 * results in their own messages -- the result it already holds.
 */
function toolCallChars(part: Message.ToolCall): number {
	return part.name.length + safeJsonStringify(part.arguments).length + toolResultChars(part);
}

function toolResultChars(part: Message.ToolCall): number {
	return "result" in part && part.result ? contentChars(part.result.content) : 0;
}

export function estimateMessageTokens(message: Message.Message): number {
	if (message.role === "user") return estimateContentTokens(message.parts);

	let chars = 0;
	for (const part of message.parts) {
		switch (part.type) {
			case "text":
				chars += part.text.length;
				break;
			case "image":
				chars += ESTIMATED_IMAGE_CHARS;
				break;
			case "thinking":
				chars += part.thinking.length;
				break;
			case "toolCall":
				chars += toolCallChars(part);
				break;
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

function lastAssistantUsage(
	messages: ReadonlyArray<Message.Message>,
): { usage: Message.Usage; index: number } | undefined {
	let latestPrefixTime = Number.NEGATIVE_INFINITY;
	let found: { usage: Message.Usage; index: number } | undefined;

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]!;
		if (message.role === "assistant") {
			/*
			 * A newer prefix message was inserted after this response (a compaction
			 * summary, say), so its usage no longer describes the current prefix.
			 */
			const appliesToPrefix = message.time.created >= latestPrefixTime;
			if (
				appliesToPrefix &&
				message.stopReason !== "aborted" &&
				message.stopReason !== "error" &&
				calculateContextTokens(message.usage) > 0
			) {
				found = { usage: message.usage, index: i };
			}
		}
		latestPrefixTime = Math.max(latestPrefixTime, message.time.created);
	}

	return found;
}

function estimateMessages(messages: ReadonlyArray<Message.Message>): ContextUsageEstimate {
	const usage = lastAssistantUsage(messages);
	if (usage) {
		const usageTokens = calculateContextTokens(usage.usage);
		// Unlike Pi's separate tool-result messages, our results are attached to
		// the assistant turn after its usage was reported. Only its output is counted.
		const latest = messages[usage.index]!;
		let resultChars = 0;
		for (const part of latest.parts) {
			if (part.type === "toolCall") resultChars += toolResultChars(part);
		}
		let trailingTokens = Math.ceil(resultChars / CHARS_PER_TOKEN);
		for (let i = usage.index + 1; i < messages.length; i++) trailingTokens += estimateMessageTokens(messages[i]!);
		return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usage.index };
	}

	let tokens = 0;
	for (const message of messages) tokens += estimateMessageTokens(message);
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

function estimateToolsTokens(tools: ReadonlyArray<Message.Tool> | undefined): number {
	if (!tools || tools.length === 0) return 0;
	return estimateTextTokens(safeJsonStringify(tools));
}

/** Tools discovered by execution of the given assistant turn or later turns. */
function toolNamesAddedAfter(messages: ReadonlyArray<Message.Message>, index: number): Set<string> {
	const names = new Set<string>();
	for (let i = index; i < messages.length; i++) {
		const message = messages[i]!;
		if (message.role !== "assistant") continue;
		for (const part of message.parts) {
			if (part.type !== "toolCall") continue;
			for (const name of part.addedToolNames ?? []) names.add(name);
		}
	}
	return names;
}

export function estimateContextTokens(context: Message.Context): ContextUsageEstimate {
	const estimate = estimateMessages(context.messages);

	/*
	 * Reported usage already includes the system prompt and the tools that were
	 * live at the time, so only what arrived since is added on top.
	 */
	if (estimate.lastUsageIndex !== null) {
		const added = toolNamesAddedAfter(context.messages, estimate.lastUsageIndex);
		const addedTokens = estimateToolsTokens(context.tools?.filter((tool) => added.has(tool.name)));
		return {
			tokens: estimate.tokens + addedTokens,
			usageTokens: estimate.usageTokens,
			trailingTokens: estimate.trailingTokens + addedTokens,
			lastUsageIndex: estimate.lastUsageIndex,
		};
	}

	const prefixTokens =
		(context.systemPrompt ? estimateTextTokens(context.systemPrompt) : 0) + estimateToolsTokens(context.tools);

	return {
		tokens: estimate.tokens + prefixTokens,
		usageTokens: estimate.usageTokens,
		trailingTokens: estimate.trailingTokens + prefixTokens,
		lastUsageIndex: estimate.lastUsageIndex,
	};
}
