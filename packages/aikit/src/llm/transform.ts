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
import type { LanguageModelV3FunctionTool, SharedV3ProviderOptions } from "@ai-sdk/provider";
import * as Message from "../message/message.ts";
import * as Transcript from "../message/transcript.ts";
import { Pricing } from "./pricing.ts";
import * as Model from "../model/model.ts";
import { resolveToolGrammar, type ResponsesToolChange } from "../providers/responses/tools.ts";
import { shortHash } from "../utils/hash.ts";
import { parseStreamingJson } from "../utils/jsonparse.ts";
import { sanitizeSurrogates } from "../utils/sanitize.ts";
import { packageForModel, resolveMethod } from "./registry.ts";
import { resolveStrictParameters } from "./strict.ts";
import { isAnthropicMessagesModel } from "./thinking.ts";

type ToolCallPart = Extract<Message.AssistantMessage["parts"][number], { type: "toolCall" }>;
type TerminalToolCall = Exclude<ToolCallPart, Message.ToolCallPendingPart | Message.ToolCallRunningPart>;

export function createAssistantMessage(
	model: Model.Info,
	thinkingLevel: Model.ThinkingLevel,
): Message.AssistantMessage {
	return Message.createAssistantMessage({
		role: "assistant",
		parts: [],
		protocol: model.protocol,
		provider: model.provider,
		model: model.id,
		thinkingLevel,
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

function userContent(parts: Message.UserMessage["parts"]): ModelMessage[] {
	const content: Exclude<UserModelMessage["content"], string> = [];
	for (const part of parts) {
		if (part.type === "text") {
			const text = sanitizeSurrogates(part.text);
			if (text.trim().length > 0) {
				content.push({ type: "text", text });
			}
			continue;
		}
		content.push({ type: "file", data: part.data, mediaType: part.mimeType });
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

const ERROR_TOOL_IMAGE_PLACEHOLDER = "(image attached after the tool results)";
const MOVED_TOOL_IMAGE_PLACEHOLDER = "(see attached image)";
const CHAT_TOOL_IMAGES_CAPTION = "Attached image(s) from tool result:";
const GEMINI_TOOL_IMAGES_CAPTION = "Tool result image:";

/**
 * Where a tool result's images go when the wire cannot carry them inside the result. Each case
 * sends them in a user message after the turn's tool results:
 * - `anthropicError`: Anthropic rejects images in error tool results.
 * - `chat`: Chat Completions adapters serialize tool result images as JSON text.
 * - `gemini`: before Gemini 3 (and for non-Gemini models), an image-only result loses its function response.
 */
type MovedImages = "anthropicError" | "chat" | "gemini";

const COPILOT = "@codeworksh/ai-sdk-github-copilot";

function isAnthropicWire(model: Model.Info, method: Model.APIMethodEnum): boolean {
	if (packageForModel(model) === COPILOT) return method === Model.APIMethodEnum.messages;
	return isAnthropicMessagesModel(model);
}

/** Whether the model runs on our own Responses transport: Codex, and Copilot's `/responses`. */
export function isOwnResponses(model: Model.Info, methodOverride?: Model.APIMethodEnum): boolean {
	if (model.protocol === Model.KnownProviderEnum.openaiCodex) return true;
	return (
		model.protocol === Model.KnownProviderEnum.githubCopilot &&
		resolveMethod(model, methodOverride) === Model.APIMethodEnum.responses
	);
}

function isChatCompletions(model: Model.Info, method: Model.APIMethodEnum): boolean {
	const npm = packageForModel(model);
	// The compatible adapter falls back to its chat model for every other method.
	if (npm === "@ai-sdk/openai-compatible") return true;
	if (npm === COPILOT) return method !== Model.APIMethodEnum.responses && method !== Model.APIMethodEnum.messages;
	return npm === "@ai-sdk/openai" && method === Model.APIMethodEnum.chat;
}

/** The Google adapter's own split: anything but Gemini 3 and later gets the legacy function response. */
function isLegacyGoogleToolResults(model: Model.Info): boolean {
	if (model.protocol !== Model.KnownProviderEnum.google && model.protocol !== Model.KnownProviderEnum.googleVertex) {
		return false;
	}
	const id = model.api?.id ?? model.id;
	const gemini = /(^|[/.])gemini-/i.test(id);
	const legacy =
		/(^|[/.])gemini-[12](?:[.-]|$)/i.test(id) ||
		/(^|[/.])gemini-pro(?:-vision)?$/i.test(id) ||
		/(^|[/.])gemini-robotics-er-1\.5(?:[.-]|$)/i.test(id);
	return !gemini || legacy;
}

function movedImages(
	toolCall: TerminalToolCall,
	model: Model.Info,
	method: Model.APIMethodEnum,
): MovedImages | undefined {
	if (!toolCall.result.content.some((content) => content.type === "image")) return;
	if (isAnthropicWire(model, method)) return toolCall.result.isError ? "anthropicError" : undefined;
	if (isChatCompletions(model, method)) return "chat";
	if (isLegacyGoogleToolResults(model)) return "gemini";
}

function toolResultOutput(toolCall: TerminalToolCall, moved: MovedImages | undefined) {
	const content =
		moved === "anthropicError"
			? Message.omitImages(toolCall.result.content, ERROR_TOOL_IMAGE_PLACEHOLDER)
			: moved
				? toolCall.result.content.filter((content) => content.type === "text")
				: toolCall.result.content;
	const joined = content
		.filter((content) => content.type === "text")
		.map((content) => sanitizeSurrogates(content.text))
		.join("\n");
	const text =
		moved && moved !== "anthropicError" && joined.trim().length === 0 ? MOVED_TOOL_IMAGE_PLACEHOLDER : joined;
	const images = content.filter((content) => content.type === "image");

	// The AI SDK's content output has no error flag, so other providers keep the images and lose
	// the flag: Google drops its `error` key, OpenAI-family wires have no flag to lose.
	if (toolCall.result.isError && images.length === 0) {
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

/**
 * OpenAI (`call_id`, at most 64 characters), Anthropic (`^[a-zA-Z0-9_-]+$`) and
 * OpenRouter upstreams take a foreign tool call ID verbatim, so a Codex
 * `call|item` ID keeps only its unique call half.
 */
export function normalizeForeignToolCallId(id: string): string {
	if (/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return id;
	return normalizeOpenAICodexIdPart(id.split("|")[0] ?? id);
}

function toolCallIdNormalizer(model: Model.Info, method: Model.APIMethodEnum) {
	if (isOwnResponses(model, method)) return normalizeOpenAICodexToolCallId;
	switch (model.protocol) {
		case Model.KnownProviderEnum.openaiCodex:
			return normalizeOpenAICodexToolCallId;
		case Model.KnownProviderEnum.openai:
		case Model.KnownProviderEnum.anthropic:
		case Model.KnownProviderEnum.googleVertexAnthropic:
		case Model.KnownProviderEnum.openrouter:
			return normalizeForeignToolCallId;
		default:
			return undefined;
	}
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

/**
 * The reasoning item our Responses transport replays from a thinking signature. Copilot
 * messages from before it ran on that transport carry `{ itemId, reasoningEncryptedContent }`
 * instead of the item; those replay when they hold encrypted content.
 */
function responsesReasoningItem(signature: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(signature);
		if (!isRecord(parsed)) return;
		if (parsed.type === "reasoning" && typeof parsed.id === "string") return signature;
		const legacy = decodeOpenAIReasoningSignature(signature);
		if (!legacy || typeof legacy.reasoningEncryptedContent !== "string") return;
		return JSON.stringify({
			type: "reasoning",
			id: legacy.itemId,
			encrypted_content: legacy.reasoningEncryptedContent,
			summary: [],
		});
	} catch {
		return;
	}
}

export function googleThoughtSignature(metadata: unknown): string | undefined {
	if (!isRecord(metadata)) return;
	for (const key of ["google", "google-vertex"]) {
		const provider = metadata[key];
		if (isRecord(provider) && typeof provider.thoughtSignature === "string") return provider.thoughtSignature;
	}
}

function assistantMessages(
	message: Message.AssistantMessage,
	model: Model.Info,
	method: Model.APIMethodEnum,
): ModelMessage[] {
	if (message.stopReason === "error" || message.stopReason === "aborted") return [];

	const assistantContent: Exclude<AssistantModelMessage["content"], string> = [];
	const toolResults: ToolModelMessage["content"] = [];
	const movedImageContent: Exclude<UserModelMessage["content"], string> = [];
	// Replay metadata for our own Responses transport, only from a message it produced.
	const responsesKey =
		isOwnResponses(model, method) && message.protocol === model.protocol && message.provider.id === model.provider.id
			? Model.optionsKey(model)
			: undefined;
	const googleReplay =
		(model.protocol === "google" || model.protocol === "google-vertex") &&
		message.protocol === model.protocol &&
		message.provider.id === model.provider.id &&
		message.model === model.id;
	const googleOptions = (signature: string | undefined) =>
		googleReplay && signature ? { [Model.optionsKey(model)]: { thoughtSignature: signature } } : undefined;

	for (const part of message.parts) {
		const google = googleOptions(
			part.type === "text"
				? part.textSignature
				: part.type === "thinking"
					? part.thinkingSignature
					: part.type === "toolCall"
						? part.thoughtSignature
						: undefined,
		);
		if (part.type === "text") {
			const text = sanitizeSurrogates(part.text);
			if (text.trim().length === 0) continue;
			assistantContent.push({
				type: "text",
				text,
				...(google ? { providerOptions: google } : {}),
				...(part.textSignature && responsesKey
					? { providerOptions: { [responsesKey]: { messageId: part.textSignature } } }
					: {}),
			});
			continue;
		}
		if (part.type === "thinking") {
			const thinking = sanitizeSurrogates(part.thinking);
			if (thinking.trim().length === 0 && !part.thinkingSignature) continue;

			if (responsesKey) {
				// Only a signed reasoning item replays; unsigned thinking is dropped.
				const reasoningItem = part.thinkingSignature ? responsesReasoningItem(part.thinkingSignature) : undefined;
				if (!reasoningItem) continue;
				assistantContent.push({
					type: "reasoning",
					text: thinking,
					providerOptions: { [responsesKey]: { reasoningItem } },
				} as (typeof assistantContent)[number]);
				continue;
			}

			if (message.protocol === Model.KnownProviderEnum.githubCopilot) {
				/*
				 * Copilot Messages models carry Anthropic signatures, and the chat endpoint
				 * cannot replay thinking at all. Thinking that cannot be replayed natively
				 * survives as plain text instead of going out unsigned.
				 */
				const openai = part.thinkingSignature ? decodeOpenAIReasoningSignature(part.thinkingSignature) : undefined;
				if (method === Model.APIMethodEnum.messages && part.thinkingSignature && !openai) {
					assistantContent.push({
						type: "reasoning",
						text: thinking,
						providerOptions: { anthropic: { signature: part.thinkingSignature } },
					} as (typeof assistantContent)[number]);
				} else if (thinking.trim().length > 0) {
					assistantContent.push({ type: "text", text: thinking });
				}
				continue;
			}

			const reasoning: Record<string, unknown> = { type: "reasoning", text: thinking };
			// OpenAI Responses only accepts native reasoning items with encoded metadata.
			if (message.protocol === Model.KnownProviderEnum.openai) {
				if (!part.thinkingSignature) continue;
				const openai = decodeOpenAIReasoningSignature(part.thinkingSignature);
				if (!openai) continue;
				reasoning.providerOptions = { openai };
			} else if (google) {
				reasoning.providerOptions = google;
			} else if (part.thinkingSignature && message.protocol !== "google" && message.protocol !== "google-vertex") {
				reasoning.providerOptions = { anthropic: { signature: part.thinkingSignature } };
			}
			assistantContent.push(reasoning as (typeof assistantContent)[number]);
			continue;
		}
		if (part.type !== "toolCall") continue;

		const responsesToolMetadata: { namespace?: string; omitItemId?: boolean } = {};
		if (responsesKey && part.namespace) responsesToolMetadata.namespace = part.namespace;
		if (responsesKey && message.model !== model.id) responsesToolMetadata.omitItemId = true;
		assistantContent.push({
			type: "tool-call",
			toolCallId: part.callID,
			toolName: part.name,
			input: sanitizeRecord(part.arguments ?? {}),
			...(google ? { providerOptions: google } : {}),
			...(responsesKey && Object.keys(responsesToolMetadata).length > 0
				? { providerOptions: { [responsesKey]: responsesToolMetadata } }
				: {}),
		});

		const terminal = part.status === "pending" || part.status === "running" ? undefined : part;
		const moved = terminal ? movedImages(terminal, model, method) : undefined;
		toolResults.push({
			type: "tool-result",
			toolCallId: part.callID,
			toolName: part.name,
			output: terminal
				? toolResultOutput(terminal, moved)
				: {
						type: "error-text",
						value: "no result provided",
					},
		});
		if (terminal && moved) {
			const caption =
				moved === "anthropicError"
					? `Images from the error result of tool call ${part.callID} (${part.name}):`
					: moved === "gemini"
						? GEMINI_TOOL_IMAGES_CAPTION
						: movedImageContent.length === 0
							? CHAT_TOOL_IMAGES_CAPTION
							: undefined;
			movedImageContent.push(
				...(caption === undefined ? [] : [{ type: "text" as const, text: caption }]),
				...terminal.result.content.flatMap((content) =>
					content.type === "image"
						? [{ type: "file" as const, data: content.data, mediaType: content.mimeType }]
						: [],
				),
			);
		}
	}

	const result: ModelMessage[] = [];
	if (assistantContent.length > 0) {
		result.push({ role: "assistant", content: assistantContent });
	}
	if (toolResults.length > 0) {
		result.push({ role: "tool", content: toolResults });
	}
	// @ai-sdk/anthropic merges this into the tool results' user message, after the tool_result blocks.
	if (movedImageContent.length > 0) {
		result.push({ role: "user", content: movedImageContent });
	}
	return result;
}

/**
 * How the model's transport expresses tool changes after the first request. Only our own
 * Responses transport can declare tools in place; the AI SDK adapters take the current tool
 * set top-level. A request limited to some tools (`activeTools`) takes them top-level too,
 * since only that list is filtered.
 */
export function transcriptToolSupport(
	model: Model.Info,
	method: Model.APIMethodEnum | undefined,
	restricted = false,
): Transcript.TranscriptToolSupport {
	if (restricted || !isOwnResponses(model, method)) return "none";
	if (supportsMidConvoSystemMessages(model, method) && model.compat?.supportsAdditionalTools) return "changes";
	return model.compat?.supportsToolSearch ? "additions" : "none";
}

/**
 * Whether prompt changes go in place as system messages. Our own Responses transport and the
 * AI SDK's OpenAI Responses and Anthropic Messages adapters keep them where they stand; Chat
 * Completions takes the current prompt as the leading system prompt.
 */
export function supportsMidConvoSystemMessages(model: Model.Info, method: Model.APIMethodEnum | undefined): boolean {
	if (model.compat?.supportsMidConvoSystemMessages !== true) return false;
	return isOwnResponses(model, method) || !isChatCompletions(model, resolveMethod(model, method));
}

/**
 * The prompt the AI SDK adapters take as `system`: the leading one when changes go in place,
 * else the current one, every change folded in.
 */
export function leadingSystemPrompt(
	context: Message.Context,
	model: Model.Info,
	method: Model.APIMethodEnum | undefined,
): string | undefined {
	return (
		Transcript.resolveTranscriptPrompt(context, supportsMidConvoSystemMessages(model, method)).systemPrompt ||
		undefined
	);
}

/** A tool as the language model receives it, for declaring it inside the prompt. */
function functionTool(tool: Message.Tool, model: Model.Info, method: Model.APIMethodEnum): LanguageModelV3FunctionTool {
	const { inputSchema, strict, providerOptions } = toolWire(tool, model, method);
	return {
		type: "function",
		name: tool.name,
		description: tool.description,
		inputSchema: JSON.parse(JSON.stringify(inputSchema)) as LanguageModelV3FunctionTool["inputSchema"],
		...(strict ? { strict } : {}),
		...(providerOptions ? { providerOptions } : {}),
	};
}

/** A system message sent in place: the prompt update `content`, then the tool change, if any. */
function systemChangeMessage(
	content: string,
	toolsAdded: readonly Message.Tool[],
	toolsRemoved: readonly Message.ToolReference[],
	support: Transcript.TranscriptToolSupport,
	model: Model.Info,
	method: Model.APIMethodEnum,
): ModelMessage | undefined {
	if (toolsAdded.length === 0 && toolsRemoved.length === 0) {
		return content.length > 0 ? { role: "system", content: sanitizeSurrogates(content) } : undefined;
	}
	const toolChange: ResponsesToolChange = {
		mode: support === "changes" ? "changes" : "additions",
		tools: toolsAdded.map((tool) => functionTool(tool, model, method)),
		removed: toolsRemoved.map((tool) => tool.name),
	};
	return {
		role: "system",
		content: sanitizeSurrogates(content),
		// Function tools are plain JSON once their schema went through `functionTool`.
		providerOptions: { [Model.optionsKey(model)]: { toolChange } } as unknown as SharedV3ProviderOptions,
	};
}

export function convertMessages(
	context: Message.Context,
	model: Model.Info,
	methodOverride?: Model.APIMethodEnum,
	activeTools?: readonly string[],
): ModelMessage[] {
	const method = resolveMethod(model, methodOverride);
	const messages: ModelMessage[] = [];
	const transformedMessages = Message.transformMessages(context.messages, model, toolCallIdNormalizer(model, method));
	const support = transcriptToolSupport(model, method, activeTools !== undefined);
	const transcript = Transcript.resolveTranscriptTools(context, support);
	const prompt = Transcript.resolveTranscriptPrompt(context, supportsMidConvoSystemMessages(model, method));

	if (transcript.initialToolsInPlace) {
		const head = systemChangeMessage("", context.tools ?? [], [], support, model, method);
		if (head) messages.push(head);
	}
	// Our Responses transport takes the leading prompt in place, after the initial tool declaration.
	if (isOwnResponses(model, method) && prompt.systemPrompt) {
		messages.push({ role: "system", content: sanitizeSurrogates(prompt.systemPrompt) });
	}

	// Anthropic takes a later system message only after a user message, and never between a tool
	// call and its result: each is held for the next assistant message, or the end (pi). One ahead
	// of the conversation joins the leading prompt instead, where it caches like the rest of it; a
	// trailing system message's cache entry is never read once a reply follows it.
	const anthropic = isAnthropicWire(model, method);
	const held: ModelMessage[] = [];
	let systemIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "system") {
			const index = systemIndex++;
			const update = index < prompt.foldedSystemMessages ? "" : Transcript.renderSystemPromptUpdate(msg);
			const folded = index < transcript.foldedSystemMessages;
			const change = systemChangeMessage(
				update,
				folded ? [] : (msg.toolsAdded ?? []),
				folded ? [] : (msg.toolsRemoved ?? []),
				support,
				model,
				method,
			);
			if (change) (anthropic && messages.some((one) => one.role !== "system") ? held : messages).push(change);
			continue;
		}
		if (msg.role === "user") {
			messages.push(...userContent(msg.parts));
			continue;
		}
		const converted = assistantMessages(msg, model, method);
		if (converted.length > 0) messages.push(...held.splice(0));
		messages.push(...converted);
	}

	return [...messages, ...held];
}

/**
 * The string input property of every grammar tool the transcript declared, for our Responses
 * transport: earlier calls to a tool since removed or redefined still replay as grammar calls.
 */
export function grammarToolInputProperties(
	context: Message.Context,
	model: Model.Info,
	method: Model.APIMethodEnum | undefined,
): Record<string, string> | undefined {
	if (!isOwnResponses(model, method)) return;
	const properties: Record<string, string> = {};
	for (const tool of Transcript.getDeclaredTools(context)) {
		const grammar = resolveToolGrammar(tool, model.compat);
		if (grammar) properties[tool.name] = grammar.inputProperty;
	}
	return Object.keys(properties).length > 0 ? properties : undefined;
}

/** The parameter schema, strict flag and grammar a tool goes out with on this model. */
function toolWire(tool: Message.Tool, model?: Model.Info, method?: Model.APIMethodEnum) {
	const strictParameters = resolveStrictParameters(tool, model);
	const grammarConstraint =
		model && isOwnResponses(model, method) ? resolveToolGrammar(tool, model.compat) : undefined;
	return {
		inputSchema: strictParameters ?? tool.parameters,
		strict: strictParameters ? true : undefined,
		providerOptions:
			model && grammarConstraint ? { [Model.optionsKey(model)]: { grammar: grammarConstraint } } : undefined,
	};
}

export function convertTools(
	tools?: Message.Tool[],
	model?: Model.Info,
	method?: Model.APIMethodEnum,
): ToolSet | undefined {
	if (!tools || tools.length === 0) return;

	const result: ToolSet = {};
	for (const tool of tools) {
		const { inputSchema, strict, providerOptions } = toolWire(tool, model, method);
		result[tool.name] = {
			description: tool.description,
			inputSchema: jsonSchema(inputSchema as any),
			...(strict ? { strict } : {}),
			...(providerOptions ? { providerOptions } : {}),
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
