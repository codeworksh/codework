import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3Content,
	LanguageModelV3FinishReason,
	LanguageModelV3GenerateResult,
	LanguageModelV3StreamPart,
	LanguageModelV3StreamResult,
	LanguageModelV3Usage,
	SharedV3Warning,
} from "@ai-sdk/provider";
import { createOpenAICodexAPICallError } from "./codex-error";
import { convertToOpenAICodexPrompt, joinToolCallId } from "./codex-prompt";
import { parseOpenAICodexSSEStream } from "./codex-sse";
import { prepareOpenAICodexTools } from "./codex-tools";
import { convertOpenAICodexUsage, mapOpenAICodexFinishReason, type OpenAICodexUsage } from "./codex-usage";

export const OPENAI_CODEX_DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";

export type OpenAICodexModelId = "gpt-5.3-codex-spark" | "gpt-5.4" | "gpt-5.4-mini" | "gpt-5.5" | (string & {});

export type OpenAICodexServiceTier = "auto" | "default" | "flex" | "scale" | "priority";

/**
 * Per-call options, passed via `providerOptions["openai-codex"]`.
 */
export type OpenAICodexLanguageModelOptions = {
	/** Reasoning effort forwarded as `reasoning.effort`. */
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | (string & {});
	/** Reasoning summary verbosity; defaults to `auto` when an effort is set. */
	reasoningSummary?: "auto" | "concise" | "detailed";
	/** Output text verbosity; defaults to `low`. */
	textVerbosity?: "low" | "medium" | "high";
	serviceTier?: OpenAICodexServiceTier;
	/** Prompt cache key; defaults to the provider `sessionId`. */
	promptCacheKey?: string;
	/** `include` fields; defaults to `["reasoning.encrypted_content"]`. */
	include?: string[];
	/** The Codex backend requires `store: false`; override only for testing. */
	store?: boolean;
};

export type OpenAICodexLanguageModelConfig = {
	provider: string;
	baseURL: string;
	headers: () => PromiseLike<Record<string, string | undefined>> | Record<string, string | undefined>;
	fetch?: typeof globalThis.fetch;
	sessionId?: string;
	serviceTier?: OpenAICodexServiceTier;
};

/**
 * Resolve the Codex responses endpoint from a base URL that may already
 * include the `/codex` or `/codex/responses` suffix.
 */
export function resolveOpenAICodexUrl(baseUrl?: string): string {
	const raw = baseUrl?.trim() ? baseUrl : OPENAI_CODEX_DEFAULT_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

type CodexEvent = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as CodexEvent) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function cleanHeaders(headers: Record<string, string | undefined>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value !== undefined) result[key] = value;
	}
	return result;
}

export class OpenAICodexLanguageModel implements LanguageModelV3 {
	readonly specificationVersion = "v3" as const;
	readonly modelId: OpenAICodexModelId;

	private readonly config: OpenAICodexLanguageModelConfig;

	constructor(modelId: OpenAICodexModelId, config: OpenAICodexLanguageModelConfig) {
		this.modelId = modelId;
		this.config = config;
	}

	get provider(): string {
		return this.config.provider;
	}

	get supportedUrls(): Record<string, RegExp[]> {
		return {};
	}

	private getArgs(options: LanguageModelV3CallOptions): {
		args: Record<string, unknown>;
		warnings: SharedV3Warning[];
	} {
		const warnings: SharedV3Warning[] = [];

		if (options.topP != null) warnings.push({ type: "unsupported", feature: "topP" });
		if (options.topK != null) warnings.push({ type: "unsupported", feature: "topK" });
		if (options.presencePenalty != null) warnings.push({ type: "unsupported", feature: "presencePenalty" });
		if (options.frequencyPenalty != null) warnings.push({ type: "unsupported", feature: "frequencyPenalty" });
		if (options.seed != null) warnings.push({ type: "unsupported", feature: "seed" });
		if (options.stopSequences != null) warnings.push({ type: "unsupported", feature: "stopSequences" });
		if (options.maxOutputTokens != null) {
			// The ChatGPT Codex backend rejects max_output_tokens with a 400.
			warnings.push({ type: "unsupported", feature: "maxOutputTokens" });
		}
		if (options.responseFormat && options.responseFormat.type !== "text") {
			warnings.push({ type: "unsupported", feature: "responseFormat" });
		}

		const codexOptions = (options.providerOptions?.["openai-codex"] ?? {}) as OpenAICodexLanguageModelOptions;
		const { instructions, input } = convertToOpenAICodexPrompt(options.prompt);
		const tools = prepareOpenAICodexTools({ tools: options.tools, toolChoice: options.toolChoice });
		warnings.push(...tools.warnings);

		const args: Record<string, unknown> = {
			model: this.modelId,
			// The ChatGPT backend rejects stored responses for Codex subscriptions.
			store: codexOptions.store ?? false,
			instructions,
			input,
			tool_choice: tools.codexToolChoice ?? "auto",
			parallel_tool_calls: true,
			include: codexOptions.include ?? ["reasoning.encrypted_content"],
			text: { verbosity: codexOptions.textVerbosity ?? "low" },
		};

		if (tools.codexTools) args.tools = tools.codexTools;
		if (options.temperature != null) args.temperature = options.temperature;

		const promptCacheKey = codexOptions.promptCacheKey ?? this.config.sessionId;
		if (promptCacheKey) args.prompt_cache_key = promptCacheKey;

		const serviceTier = codexOptions.serviceTier ?? this.config.serviceTier;
		if (serviceTier) args.service_tier = serviceTier;

		if (codexOptions.reasoningEffort) {
			args.reasoning = {
				effort: codexOptions.reasoningEffort,
				summary: codexOptions.reasoningSummary ?? "auto",
			};
		}

		return { args, warnings };
	}

	async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
		const { stream, request, response } = await this.doStream(options);

		const content: LanguageModelV3Content[] = [];
		const textBlocks = new Map<string, { type: "text"; text: string }>();
		const reasoningBlocks = new Map<string, { type: "reasoning"; text: string }>();
		const warnings: SharedV3Warning[] = [];
		let finishReason: LanguageModelV3FinishReason = { unified: "other", raw: undefined };
		let usage: LanguageModelV3Usage = convertOpenAICodexUsage(undefined);
		let responseId: string | undefined;
		let responseModelId: string | undefined;

		const reader = stream.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			switch (value.type) {
				case "stream-start":
					warnings.push(...value.warnings);
					break;
				case "response-metadata":
					responseId = value.id;
					responseModelId = value.modelId;
					break;
				case "text-start": {
					const block = { type: "text" as const, text: "" };
					textBlocks.set(value.id, block);
					content.push(block);
					break;
				}
				case "text-delta": {
					const block = textBlocks.get(value.id);
					if (block) block.text += value.delta;
					break;
				}
				case "reasoning-start": {
					const block = { type: "reasoning" as const, text: "" };
					reasoningBlocks.set(value.id, block);
					content.push(block);
					break;
				}
				case "reasoning-delta": {
					const block = reasoningBlocks.get(value.id);
					if (block) block.text += value.delta;
					break;
				}
				case "tool-call":
					content.push(value);
					break;
				case "finish":
					finishReason = value.finishReason;
					usage = value.usage;
					break;
				case "error":
					throw value.error instanceof Error ? value.error : new Error(String(value.error));
			}
		}

		return {
			content: content.filter((part) =>
				part.type === "text" || part.type === "reasoning" ? part.text !== "" : true,
			),
			finishReason,
			usage,
			request,
			response: { ...response, id: responseId, modelId: responseModelId },
			warnings,
		};
	}

	async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
		const { args, warnings } = this.getArgs(options);
		const body = { ...args, stream: true };
		const url = resolveOpenAICodexUrl(this.config.baseURL);

		const headers = cleanHeaders({
			...(await this.config.headers()),
			...options.headers,
		});

		const fetchImpl = this.config.fetch ?? globalThis.fetch;
		const response = await fetchImpl(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: options.abortSignal,
		});

		if (!response.ok) {
			throw await createOpenAICodexAPICallError({ response, url, requestBodyValues: body });
		}
		if (!response.body) {
			throw new Error("OpenAI Codex response has no body");
		}

		const responseHeaders: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			responseHeaders[key] = value;
		});

		return {
			stream: parseOpenAICodexSSEStream(response.body).pipeThrough(
				this.createTransformStream(warnings, options.includeRawChunks ?? false),
			),
			request: { body },
			response: { headers: responseHeaders },
		};
	}

	private createTransformStream(
		warnings: SharedV3Warning[],
		includeRawChunks: boolean,
	): TransformStream<CodexEvent, LanguageModelV3StreamPart> {
		let finishReason: LanguageModelV3FinishReason = { unified: "other", raw: undefined };
		let usage: OpenAICodexUsage | undefined;
		let hasToolCalls = false;
		// function_call argument deltas arrive keyed by item id; tool parts use the
		// composite `call_id|item_id` so multi-turn replay can recover both halves.
		const toolCallIdsByItemId = new Map<string, string>();

		const handleOutputItemAdded = (
			item: CodexEvent,
			controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
		) => {
			const itemType = asString(item.type);
			const itemId = asString(item.id);
			if (!itemType || !itemId) return;

			if (itemType === "message") {
				controller.enqueue({ type: "text-start", id: itemId });
			} else if (itemType === "reasoning") {
				controller.enqueue({ type: "reasoning-start", id: itemId });
			} else if (itemType === "function_call") {
				const toolCallId = joinToolCallId(asString(item.call_id) ?? itemId, itemId);
				toolCallIdsByItemId.set(itemId, toolCallId);
				hasToolCalls = true;
				controller.enqueue({
					type: "tool-input-start",
					id: toolCallId,
					toolName: asString(item.name) ?? "",
				});
			}
		};

		const handleOutputItemDone = (
			item: CodexEvent,
			controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
		) => {
			const itemType = asString(item.type);
			const itemId = asString(item.id);
			if (!itemType || !itemId) return;

			if (itemType === "message") {
				controller.enqueue({ type: "text-end", id: itemId });
			} else if (itemType === "reasoning") {
				controller.enqueue({ type: "reasoning-end", id: itemId });
			} else if (itemType === "function_call") {
				const toolCallId =
					toolCallIdsByItemId.get(itemId) ?? joinToolCallId(asString(item.call_id) ?? itemId, itemId);
				hasToolCalls = true;
				controller.enqueue({ type: "tool-input-end", id: toolCallId });
				controller.enqueue({
					type: "tool-call",
					toolCallId,
					toolName: asString(item.name) ?? "",
					input: asString(item.arguments) ?? "",
				});
			}
		};

		return new TransformStream<CodexEvent, LanguageModelV3StreamPart>({
			start(controller) {
				controller.enqueue({ type: "stream-start", warnings });
			},

			transform(event, controller) {
				if (includeRawChunks) {
					controller.enqueue({ type: "raw", rawValue: event });
				}

				const type = asString(event.type);
				if (!type) return;

				switch (type) {
					case "response.created": {
						const response = asRecord(event.response);
						controller.enqueue({
							type: "response-metadata",
							id: asString(response?.id),
							modelId: asString(response?.model),
						});
						break;
					}

					case "response.output_item.added": {
						const item = asRecord(event.item);
						if (item) handleOutputItemAdded(item, controller);
						break;
					}

					case "response.output_text.delta": {
						const itemId = asString(event.item_id);
						const delta = asString(event.delta);
						if (itemId && delta) controller.enqueue({ type: "text-delta", id: itemId, delta });
						break;
					}

					case "response.reasoning_text.delta":
					case "response.reasoning_summary_text.delta": {
						const itemId = asString(event.item_id);
						const delta = asString(event.delta);
						if (itemId && delta) controller.enqueue({ type: "reasoning-delta", id: itemId, delta });
						break;
					}

					case "response.function_call_arguments.delta": {
						const itemId = asString(event.item_id);
						const delta = asString(event.delta);
						const toolCallId = itemId ? toolCallIdsByItemId.get(itemId) : undefined;
						if (toolCallId && delta) controller.enqueue({ type: "tool-input-delta", id: toolCallId, delta });
						break;
					}

					case "response.output_item.done": {
						const item = asRecord(event.item);
						if (item) handleOutputItemDone(item, controller);
						break;
					}

					case "response.completed":
					case "response.done":
					case "response.incomplete": {
						const response = asRecord(event.response);
						usage = (response?.usage as OpenAICodexUsage | undefined) ?? usage;
						const status =
							asString(response?.status) ?? (type === "response.incomplete" ? "incomplete" : "completed");
						finishReason = mapOpenAICodexFinishReason(status, hasToolCalls);
						break;
					}

					case "response.failed": {
						const response = asRecord(event.response);
						const error = asRecord(response?.error);
						finishReason = { unified: "error", raw: "failed" };
						controller.enqueue({
							type: "error",
							error: new Error(asString(error?.message) ?? "OpenAI Codex response failed"),
						});
						break;
					}

					case "error": {
						const code = asString(event.code);
						const message = asString(event.message);
						finishReason = { unified: "error", raw: code ?? "error" };
						controller.enqueue({
							type: "error",
							error: new Error(
								`OpenAI Codex error${code ? ` ${code}` : ""}: ${message ?? JSON.stringify(event)}`,
							),
						});
						break;
					}

					default:
						// Ignore lifecycle events we do not surface (content_part, in_progress, ...).
						break;
				}
			},

			flush(controller) {
				controller.enqueue({
					type: "finish",
					finishReason,
					usage: convertOpenAICodexUsage(usage),
				});
			},
		});
	}
}
