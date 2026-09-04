import type * as NodeZlib from "node:zlib";
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
import {
	createOpenAICodexAPICallError,
	createOpenAICodexPrematureCloseError,
	createOpenAICodexStreamError,
} from "./codex-error.ts";
import { collectOpenAICodexDeferredToolNames, convertToOpenAICodexPrompt, joinToolCallId } from "./codex-prompt.ts";
import { parseOpenAICodexSSEStream } from "./codex-sse.ts";
import {
	appendOpenAICodexGrammarInputJsonDelta,
	prepareOpenAICodexTools,
	resolveOpenAICodexDeferredToolsMode,
	type OpenAICodexGrammarInputBuffer,
} from "./codex-tools.ts";
import { convertOpenAICodexUsage, mapOpenAICodexFinishReason, type OpenAICodexUsage } from "./codex-usage.ts";

export const OPENAI_CODEX_DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
export const OPENAI_CODEX_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
const REQUEST_COMPRESSION_ZSTD_LEVEL = 3;

type ProcessWithBuiltinModule = typeof process & {
	getBuiltinModule?: (id: "node:zlib") => typeof NodeZlib;
};

function compressOpenAICodexRequest(body: string): Uint8Array | undefined {
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) return undefined;
	const zlib = (process as ProcessWithBuiltinModule).getBuiltinModule?.("node:zlib");
	if (!zlib || typeof zlib.zstdCompressSync !== "function") return undefined;
	try {
		const compressed = zlib.zstdCompressSync(body, {
			params: { [zlib.constants.ZSTD_c_compressionLevel]: REQUEST_COMPRESSION_ZSTD_LEVEL },
		});
		return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
	} catch {
		return undefined;
	}
}

export function clampOpenAICodexPromptCacheKey(key: string | undefined): string | undefined {
	if (key === undefined) return undefined;
	const characters = Array.from(key);
	return characters.length <= OPENAI_CODEX_PROMPT_CACHE_KEY_MAX_LENGTH
		? key
		: characters.slice(0, OPENAI_CODEX_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

export type OpenAICodexModelId =
	| "gpt-5.3-codex-spark"
	| "gpt-5.4"
	| "gpt-5.4-mini"
	| "gpt-5.5"
	| "gpt-5.6-luna"
	| "gpt-5.6-sol"
	| "gpt-5.6-terra"
	| (string & {});

export type OpenAICodexServiceTier = "auto" | "default" | "flex" | "scale" | "priority";

export type OpenAICodexCompatibility = {
	supportsToolSearch?: boolean;
	supportsAdditionalTools?: boolean;
	supportsStrictMode?: boolean;
	supportsOpenAIGrammarTools?: boolean;
	/** Internal transport capability derived from the model's input modalities. */
	supportsImages?: boolean;
};

/**
 * Per-call options, passed via `providerOptions["openai-codex"]`.
 */
export type OpenAICodexLanguageModelOptions = {
	/** Reasoning effort forwarded as `reasoning.effort`. */
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | (string & {});
	/** Reasoning summary verbosity; defaults to `auto` when an effort is set. */
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
	/** Output text verbosity; defaults to `low`. */
	textVerbosity?: "low" | "medium" | "high";
	serviceTier?: OpenAICodexServiceTier;
};

export type OpenAICodexLanguageModelConfig = {
	provider: string;
	baseURL: string;
	headers: () => PromiseLike<Record<string, string | undefined>> | Record<string, string | undefined>;
	fetch?: typeof globalThis.fetch;
	sessionId?: string;
	serviceTier?: OpenAICodexServiceTier;
	compat?: OpenAICodexCompatibility;
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
		grammarToolInputProperties: ReadonlyMap<string, string>;
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
		if (options.responseFormat?.type === "json" && options.responseFormat.schema === undefined) {
			warnings.push({ type: "unsupported", feature: "responseFormat" });
		}

		const codexOptions = (options.providerOptions?.["openai-codex"] ?? {}) as OpenAICodexLanguageModelOptions;
		const deferredToolsMode = resolveOpenAICodexDeferredToolsMode(this.modelId, this.config.compat);
		const deferredToolNames = deferredToolsMode ? collectOpenAICodexDeferredToolNames(options.prompt) : undefined;
		const tools = prepareOpenAICodexTools({
			tools: options.tools,
			toolChoice: options.toolChoice,
			...(deferredToolNames !== undefined && { deferredToolNames }),
		});
		const { instructions, input } = convertToOpenAICodexPrompt(options.prompt, {
			deferredTools: tools.deferredCodexTools,
			...(deferredToolsMode !== undefined && { deferredToolsMode }),
			grammarToolInputProperties: tools.grammarToolInputProperties,
			supportsImages: this.config.compat?.supportsImages ?? this.modelId !== "gpt-5.3-codex-spark",
		});
		warnings.push(...tools.warnings);

		const text: Record<string, unknown> = { verbosity: codexOptions.textVerbosity ?? "low" };
		if (options.responseFormat?.type === "json" && options.responseFormat.schema !== undefined) {
			text.format = {
				type: "json_schema",
				strict: true,
				schema: options.responseFormat.schema,
				name: options.responseFormat.name ?? "codex_output_schema",
			};
		}

		const args: Record<string, unknown> = {
			model: this.modelId,
			// The ChatGPT backend rejects stored responses for Codex subscriptions.
			store: false,
			instructions,
			input,
			tool_choice: tools.codexToolChoice ?? "auto",
			parallel_tool_calls: true,
			include: ["reasoning.encrypted_content"],
			text,
		};

		if (tools.codexTools) args.tools = tools.codexTools;
		if (options.temperature != null) args.temperature = options.temperature;

		const promptCacheKey = clampOpenAICodexPromptCacheKey(this.config.sessionId);
		if (promptCacheKey) args.prompt_cache_key = promptCacheKey;

		const serviceTier = codexOptions.serviceTier ?? this.config.serviceTier;
		if (serviceTier) args.service_tier = serviceTier;

		if (codexOptions.reasoningEffort) {
			args.reasoning = {
				effort: codexOptions.reasoningEffort,
				summary: codexOptions.reasoningSummary ?? "auto",
			};
		}

		return { args, warnings, grammarToolInputProperties: tools.grammarToolInputProperties };
	}

	async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
		const { stream, request, response } = await this.doStream(options);

		const content: LanguageModelV3Content[] = [];
		const textBlocks = new Map<string, Extract<LanguageModelV3Content, { type: "text" }>>();
		const reasoningBlocks = new Map<string, Extract<LanguageModelV3Content, { type: "reasoning" }>>();
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
				case "text-end": {
					const block = textBlocks.get(value.id);
					if (block && value.providerMetadata !== undefined) block.providerMetadata = value.providerMetadata;
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
				case "reasoning-end": {
					const block = reasoningBlocks.get(value.id);
					if (block && value.providerMetadata !== undefined) block.providerMetadata = value.providerMetadata;
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
				part.type === "text" || part.type === "reasoning"
					? part.text !== "" || part.providerMetadata !== undefined
					: true,
			),
			finishReason,
			usage,
			...(request !== undefined && { request }),
			response: {
				...response,
				...(responseId !== undefined && { id: responseId }),
				...(responseModelId !== undefined && { modelId: responseModelId }),
			},
			warnings,
		};
	}

	async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
		const { args, warnings, grammarToolInputProperties } = this.getArgs(options);
		const body = { ...args, stream: true };
		const url = resolveOpenAICodexUrl(this.config.baseURL);

		const headers = cleanHeaders({
			...(await this.config.headers()),
			...options.headers,
		});
		const bodyJson = JSON.stringify(body);
		const compressedBody = compressOpenAICodexRequest(bodyJson);
		if (compressedBody) headers["content-encoding"] = "zstd";

		const fetchImpl = this.config.fetch ?? globalThis.fetch;
		const response = await fetchImpl(url, {
			method: "POST",
			headers,
			body: compressedBody ?? bodyJson,
			...(options.abortSignal !== undefined && { signal: options.abortSignal }),
		});

		if (!response.ok) {
			throw await createOpenAICodexAPICallError({ response, url, requestBodyValues: body });
		}
		if (!response.body) {
			throw new Error("openAI codex response has no body");
		}

		const responseHeaders: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			responseHeaders[key] = value;
		});

		return {
			stream: parseOpenAICodexSSEStream(response.body).pipeThrough(
				this.createTransformStream(warnings, options.includeRawChunks ?? false, grammarToolInputProperties, {
					url,
					requestBodyValues: body,
					responseHeaders,
				}),
			),
			request: { body },
			response: { headers: responseHeaders },
		};
	}

	private createTransformStream(
		warnings: SharedV3Warning[],
		includeRawChunks: boolean,
		grammarToolInputProperties: ReadonlyMap<string, string>,
		request: {
			url: string;
			requestBodyValues: unknown;
			responseHeaders: Record<string, string>;
		},
	): TransformStream<CodexEvent, LanguageModelV3StreamPart> {
		let finishReason: LanguageModelV3FinishReason = { unified: "other", raw: undefined };
		let usage: OpenAICodexUsage | undefined;
		let hasToolCalls = false;
		let finished = false;
		let servedServiceTier: string | undefined;
		// function_call argument deltas arrive keyed by item id; tool parts use the
		// composite `call_id|item_id` so multi-turn replay can recover both halves.
		const toolCallIdsByItemId = new Map<string, string>();
		const customToolInputsByItemId = new Map<
			string,
			{
				toolCallId: string;
				toolName: string;
				inputProperty: string;
				buffer: OpenAICodexGrammarInputBuffer;
			}
		>();
		const finish = (controller: TransformStreamDefaultController<LanguageModelV3StreamPart>): void => {
			if (finished) return;
			finished = true;
			controller.enqueue({
				type: "finish",
				finishReason,
				usage: convertOpenAICodexUsage(usage),
				// The tier the response was served at decides what it costs, and it is
				// not always the tier that was requested.
				...(servedServiceTier === undefined
					? {}
					: { providerMetadata: { "openai-codex": { serviceTier: servedServiceTier } } }),
			});
		};
		const fail = (controller: TransformStreamDefaultController<LanguageModelV3StreamPart>, error: unknown): void => {
			if (finished) return;
			finished = true;
			controller.enqueue({ type: "error", error });
			controller.terminate();
		};

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
			} else if (itemType === "custom_tool_call") {
				const toolName = asString(item.name) ?? "";
				const inputProperty = grammarToolInputProperties.get(toolName) ?? "input";
				const toolCallId = joinToolCallId(asString(item.call_id) ?? itemId, itemId);
				customToolInputsByItemId.set(itemId, {
					toolCallId,
					toolName,
					inputProperty,
					buffer: { input: "", started: false, closed: false },
				});
				hasToolCalls = true;
				controller.enqueue({ type: "tool-input-start", id: toolCallId, toolName });
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
				controller.enqueue({
					type: "text-end",
					id: itemId,
					providerMetadata: { "openai-codex": { messageId: itemId } },
				});
			} else if (itemType === "reasoning") {
				controller.enqueue({
					type: "reasoning-end",
					id: itemId,
					providerMetadata: { "openai-codex": { reasoningItem: JSON.stringify(item) } },
				});
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
					...(asString(item.namespace)
						? { providerMetadata: { "openai-codex": { namespace: asString(item.namespace)! } } }
						: {}),
				});
			} else if (itemType === "custom_tool_call") {
				const state = customToolInputsByItemId.get(itemId);
				if (!state) return;
				const input = asString(item.input) ?? state.buffer.input;
				const delta = appendOpenAICodexGrammarInputJsonDelta(state.buffer, state.inputProperty, input, true);
				if (delta) controller.enqueue({ type: "tool-input-delta", id: state.toolCallId, delta });
				hasToolCalls = true;
				controller.enqueue({ type: "tool-input-end", id: state.toolCallId });
				controller.enqueue({
					type: "tool-call",
					toolCallId: state.toolCallId,
					toolName: state.toolName,
					input: JSON.stringify({ [state.inputProperty]: input }),
					...(asString(item.namespace)
						? { providerMetadata: { "openai-codex": { namespace: asString(item.namespace)! } } }
						: {}),
				});
				customToolInputsByItemId.delete(itemId);
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
						const id = asString(response?.id);
						const modelId = asString(response?.model);
						controller.enqueue({
							type: "response-metadata",
							...(id !== undefined && { id }),
							...(modelId !== undefined && { modelId }),
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

					case "response.custom_tool_call_input.delta": {
						const itemId = asString(event.item_id);
						const delta = asString(event.delta);
						const state = itemId ? customToolInputsByItemId.get(itemId) : undefined;
						if (!state || delta === undefined) break;
						const jsonDelta = appendOpenAICodexGrammarInputJsonDelta(
							state.buffer,
							state.inputProperty,
							state.buffer.input + delta,
							false,
						);
						if (jsonDelta)
							controller.enqueue({ type: "tool-input-delta", id: state.toolCallId, delta: jsonDelta });
						break;
					}

					case "response.custom_tool_call_input.done": {
						const itemId = asString(event.item_id);
						const input = asString(event.input);
						const state = itemId ? customToolInputsByItemId.get(itemId) : undefined;
						if (!state || input === undefined) break;
						const jsonDelta = appendOpenAICodexGrammarInputJsonDelta(
							state.buffer,
							state.inputProperty,
							input,
							true,
						);
						if (jsonDelta)
							controller.enqueue({ type: "tool-input-delta", id: state.toolCallId, delta: jsonDelta });
						break;
					}

					case "response.output_item.done": {
						const item = asRecord(event.item);
						if (item) handleOutputItemDone(item, controller);
						break;
					}

					case "response.completed":
					case "response.incomplete": {
						const response = asRecord(event.response);
						usage = (response?.usage as OpenAICodexUsage | undefined) ?? usage;
						servedServiceTier = asString(response?.service_tier) ?? servedServiceTier;
						const status =
							asString(response?.status) ?? (type === "response.incomplete" ? "incomplete" : "completed");
						const incompleteReason = asString(asRecord(response?.incomplete_details)?.reason);
						finishReason = mapOpenAICodexFinishReason(status, hasToolCalls, incompleteReason);
						finish(controller);
						controller.terminate();
						break;
					}

					case "response.failed": {
						const response = asRecord(event.response);
						const error = asRecord(response?.error);
						finishReason = { unified: "error", raw: "failed" };
						fail(
							controller,
							createOpenAICodexStreamError({
								error: error ?? { message: "OpenAI Codex response failed" },
								...request,
							}),
						);
						break;
					}

					case "error": {
						const code = asString(event.code);
						finishReason = { unified: "error", raw: code ?? "error" };
						fail(controller, createOpenAICodexStreamError({ error: event, ...request }));
						break;
					}

					default:
						// Ignore lifecycle events we do not surface (content_part, in_progress, ...).
						break;
				}
			},

			flush(controller) {
				if (!finished) {
					finished = true;
					controller.enqueue({
						type: "error",
						error: createOpenAICodexPrematureCloseError(request),
					});
				}
			},
		});
	}
}
