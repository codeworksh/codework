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
	createResponsesAPICallError,
	responsesFetchError,
	createResponsesPrematureCloseError,
	createResponsesStreamError,
} from "./error.ts";
import { collectInPlaceToolNames, convertToResponsesPrompt, joinToolCallId } from "./prompt.ts";
import { parseResponsesSSEStream } from "./sse.ts";
import { appendGrammarInputJsonDelta, prepareResponsesTools, type GrammarInputBuffer } from "./tools.ts";
import { convertResponsesUsage, mapResponsesFinishReason, type ResponsesUsage } from "./usage.ts";

export const PROMPT_CACHE_KEY_MAX_LENGTH = 64;
const REQUEST_COMPRESSION_ZSTD_LEVEL = 3;
// The Responses API rejects max_output_tokens below 16.
const MIN_OUTPUT_TOKENS = 16;

type ProcessWithBuiltinModule = typeof process & {
	getBuiltinModule?: (id: "node:zlib") => typeof NodeZlib;
};

function compressRequest(body: string): Uint8Array | undefined {
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

export function clampPromptCacheKey(key: string | undefined): string | undefined {
	if (key === undefined) return undefined;
	const characters = Array.from(key);
	return characters.length <= PROMPT_CACHE_KEY_MAX_LENGTH
		? key
		: characters.slice(0, PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

export type ResponsesServiceTier = "auto" | "default" | "flex" | "scale" | "priority";

export type ResponsesCompatibility = {
	/** Internal transport capability derived from the model's input modalities. */
	supportsImages?: boolean;
};

/**
 * Per-call options, passed via `providerOptions[<provider>]`.
 */
export type ResponsesLanguageModelOptions = {
	/** Reasoning effort forwarded as `reasoning.effort`. */
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | (string & {});
	/** Reasoning summary verbosity; defaults to `auto` when an effort is set. */
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
	/** Output text verbosity; defaults to the backend's `request.textVerbosity`. */
	textVerbosity?: "low" | "medium" | "high";
	serviceTier?: ResponsesServiceTier;
	/**
	 * The string input property of each grammar tool the conversation declared, including tools
	 * since removed, so their earlier calls replay as grammar calls. The current tools win.
	 */
	grammarToolInputProperties?: Record<string, string>;
};

/** How one Responses backend takes a request. */
export type ResponsesRequestProfile = {
	/** Where system prompt text goes: the `instructions` field, or a developer message in place. */
	systemPrompt: "instructions" | "developer";
	/** Whether `max_output_tokens` is sent; the ChatGPT Codex backend rejects it. */
	maxOutputTokens: boolean;
	/** Whether `reasoning.encrypted_content` is requested on every call or only with an effort. */
	encryptedReasoning: "always" | "withEffort";
	/** zstd-compress the body; a fetch that reads the JSON body needs it uncompressed. */
	compress: boolean;
	/**
	 * Whether `tool_choice: "auto"` and `parallel_tool_calls` go on every request, as the Codex
	 * backend expects. Otherwise only a tool choice the call names is sent: some proxied models
	 * (Grok on Copilot) reject either field on a request without tools.
	 */
	toolDefaults: boolean;
	/** `text.verbosity` when the call sets none. */
	textVerbosity?: ResponsesLanguageModelOptions["textVerbosity"];
};

export type ResponsesLanguageModelConfig = {
	/** Provider name, and the providerOptions / providerMetadata key. */
	provider: string;
	/** Backend name for error messages, e.g. "OpenAI Codex". */
	label: string;
	url: string;
	headers: () => PromiseLike<Record<string, string | undefined>> | Record<string, string | undefined>;
	fetch?: typeof globalThis.fetch;
	promptCacheKey?: string;
	serviceTier?: ResponsesServiceTier;
	compat?: ResponsesCompatibility;
	request: ResponsesRequestProfile;
};

type ResponsesEvent = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as ResponsesEvent) : undefined;
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

export class ResponsesLanguageModel implements LanguageModelV3 {
	readonly specificationVersion = "v3" as const;
	readonly modelId: string;

	private readonly config: ResponsesLanguageModelConfig;

	constructor(modelId: string, config: ResponsesLanguageModelConfig) {
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
		if (options.maxOutputTokens != null && !this.config.request.maxOutputTokens) {
			warnings.push({ type: "unsupported", feature: "maxOutputTokens" });
		}
		if (options.responseFormat?.type === "json" && options.responseFormat.schema === undefined) {
			warnings.push({ type: "unsupported", feature: "responseFormat" });
		}

		const { provider, request } = this.config;
		const callOptions = (options.providerOptions?.[provider] ?? {}) as ResponsesLanguageModelOptions;
		const tools = prepareResponsesTools({
			provider,
			tools: options.tools,
			toolChoice: options.toolChoice,
			inPlaceToolNames: collectInPlaceToolNames(options.prompt, provider),
		});
		const { instructions, input } = convertToResponsesPrompt(options.prompt, {
			provider,
			systemPrompt: request.systemPrompt,
			grammarToolInputProperties: new Map([
				...Object.entries(callOptions.grammarToolInputProperties ?? {}),
				...tools.grammarToolInputProperties,
			]),
			supportsImages: this.config.compat?.supportsImages ?? false,
		});
		warnings.push(...tools.warnings);

		const verbosity = callOptions.textVerbosity ?? request.textVerbosity;
		const text: Record<string, unknown> = verbosity ? { verbosity } : {};
		if (options.responseFormat?.type === "json" && options.responseFormat.schema !== undefined) {
			text.format = {
				type: "json_schema",
				strict: true,
				schema: options.responseFormat.schema,
				name: options.responseFormat.name ?? "output_schema",
			};
		}

		const args: Record<string, unknown> = {
			model: this.modelId,
			// Reasoning replays from encrypted content, so nothing is stored server-side.
			store: false,
			...(instructions !== undefined && { instructions }),
			input,
			...(request.toolDefaults
				? { tool_choice: tools.toolChoiceValue ?? "auto", parallel_tool_calls: true }
				: tools.toolChoiceValue !== undefined && { tool_choice: tools.toolChoiceValue }),
			...((request.encryptedReasoning === "always" || callOptions.reasoningEffort) && {
				include: ["reasoning.encrypted_content"],
			}),
			...(Object.keys(text).length > 0 && { text }),
		};

		if (tools.responsesTools) args.tools = tools.responsesTools;
		if (options.temperature != null) args.temperature = options.temperature;
		if (request.maxOutputTokens && options.maxOutputTokens != null) {
			args.max_output_tokens = Math.max(options.maxOutputTokens, MIN_OUTPUT_TOKENS);
		}

		const promptCacheKey = clampPromptCacheKey(this.config.promptCacheKey);
		if (promptCacheKey) args.prompt_cache_key = promptCacheKey;

		const serviceTier = callOptions.serviceTier ?? this.config.serviceTier;
		if (serviceTier) args.service_tier = serviceTier;

		if (callOptions.reasoningEffort) {
			args.reasoning = {
				effort: callOptions.reasoningEffort,
				summary: callOptions.reasoningSummary ?? "auto",
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
		let usage: LanguageModelV3Usage = convertResponsesUsage(undefined);
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
		const { url, label } = this.config;

		const headers = cleanHeaders({
			...(await this.config.headers()),
			...options.headers,
		});
		const bodyJson = JSON.stringify(body);
		const compressedBody = this.config.request.compress ? compressRequest(bodyJson) : undefined;
		if (compressedBody) headers["content-encoding"] = "zstd";

		const fetchImpl = this.config.fetch ?? globalThis.fetch;
		const response = await fetchImpl(url, {
			method: "POST",
			headers,
			body: compressedBody ?? bodyJson,
			...(options.abortSignal !== undefined && { signal: options.abortSignal }),
		}).catch((error: unknown) => {
			throw responsesFetchError(error, url, body);
		});

		if (!response.ok) {
			throw await createResponsesAPICallError({ label, response, url, requestBodyValues: body });
		}
		if (!response.body) {
			throw new Error(`${label} response has no body`);
		}

		const responseHeaders: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			responseHeaders[key] = value;
		});

		return {
			stream: parseResponsesSSEStream(response.body).pipeThrough(
				this.createTransformStream(warnings, options.includeRawChunks ?? false, grammarToolInputProperties, {
					label,
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
			label: string;
			url: string;
			requestBodyValues: unknown;
			responseHeaders: Record<string, string>;
		},
	): TransformStream<ResponsesEvent, LanguageModelV3StreamPart> {
		const { provider } = this.config;
		let finishReason: LanguageModelV3FinishReason = { unified: "other", raw: undefined };
		let usage: ResponsesUsage | undefined;
		let hasToolCalls = false;
		let finished = false;
		let servedServiceTier: string | undefined;
		/*
		 * Items are tracked by `output_index`: Copilot sends a different item id on every
		 * event of the same item. Tool parts use the composite `call_id|item_id` from the
		 * item's first event so multi-turn replay can recover both halves.
		 */
		type Slot =
			| { kind: "text"; id: string }
			| { kind: "reasoning"; id: string }
			| { kind: "function"; toolCallId: string; toolName: string }
			| {
					kind: "custom";
					toolCallId: string;
					toolName: string;
					inputProperty: string;
					buffer: GrammarInputBuffer;
			  };
		const slots = new Map<string, Slot>();
		const slotKey = (event: ResponsesEvent, item?: ResponsesEvent): string | undefined =>
			typeof event.output_index === "number"
				? `#${event.output_index}`
				: (asString(event.item_id) ?? asString(item?.id));
		const finish = (controller: TransformStreamDefaultController<LanguageModelV3StreamPart>): void => {
			if (finished) return;
			finished = true;
			controller.enqueue({
				type: "finish",
				finishReason,
				usage: convertResponsesUsage(usage),
				// The tier the response was served at decides what it costs, and it is
				// not always the tier that was requested.
				...(servedServiceTier === undefined
					? {}
					: { providerMetadata: { [provider]: { serviceTier: servedServiceTier } } }),
			});
		};
		const fail = (controller: TransformStreamDefaultController<LanguageModelV3StreamPart>, error: unknown): void => {
			if (finished) return;
			finished = true;
			controller.enqueue({ type: "error", error });
			controller.terminate();
		};

		const startSlot = (
			key: string,
			item: ResponsesEvent,
			controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
		): Slot | undefined => {
			const itemType = asString(item.type);
			const itemId = asString(item.id);
			if (!itemType || !itemId) return;

			let slot: Slot | undefined;
			if (itemType === "message") {
				slot = { kind: "text", id: itemId };
				controller.enqueue({ type: "text-start", id: itemId });
			} else if (itemType === "reasoning") {
				slot = { kind: "reasoning", id: itemId };
				controller.enqueue({ type: "reasoning-start", id: itemId });
			} else if (itemType === "function_call") {
				const toolName = asString(item.name) ?? "";
				slot = { kind: "function", toolCallId: joinToolCallId(asString(item.call_id) ?? itemId, itemId), toolName };
				hasToolCalls = true;
				controller.enqueue({ type: "tool-input-start", id: slot.toolCallId, toolName });
			} else if (itemType === "custom_tool_call") {
				const toolName = asString(item.name) ?? "";
				slot = {
					kind: "custom",
					toolCallId: joinToolCallId(asString(item.call_id) ?? itemId, itemId),
					toolName,
					inputProperty: grammarToolInputProperties.get(toolName) ?? "input",
					buffer: { input: "", started: false, closed: false },
				};
				hasToolCalls = true;
				controller.enqueue({ type: "tool-input-start", id: slot.toolCallId, toolName });
			}
			if (slot) slots.set(key, slot);
			return slot;
		};

		const endSlot = (
			key: string,
			item: ResponsesEvent,
			controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
		) => {
			const slot = slots.get(key) ?? startSlot(key, item, controller);
			if (!slot) return;
			slots.delete(key);
			const namespace = asString(item.namespace);
			const namespaceMetadata = namespace ? { providerMetadata: { [provider]: { namespace } } } : {};

			if (slot.kind === "text") {
				const messageId = asString(item.id) ?? slot.id;
				controller.enqueue({ type: "text-end", id: slot.id, providerMetadata: { [provider]: { messageId } } });
			} else if (slot.kind === "reasoning") {
				controller.enqueue({
					type: "reasoning-end",
					id: slot.id,
					providerMetadata: { [provider]: { reasoningItem: JSON.stringify(item) } },
				});
			} else if (slot.kind === "function") {
				controller.enqueue({ type: "tool-input-end", id: slot.toolCallId });
				controller.enqueue({
					type: "tool-call",
					toolCallId: slot.toolCallId,
					toolName: asString(item.name) ?? slot.toolName,
					input: asString(item.arguments) ?? "",
					...namespaceMetadata,
				});
			} else {
				const input = asString(item.input) ?? slot.buffer.input;
				const delta = appendGrammarInputJsonDelta(slot.buffer, slot.inputProperty, input, true);
				if (delta) controller.enqueue({ type: "tool-input-delta", id: slot.toolCallId, delta });
				controller.enqueue({ type: "tool-input-end", id: slot.toolCallId });
				controller.enqueue({
					type: "tool-call",
					toolCallId: slot.toolCallId,
					toolName: slot.toolName,
					input: JSON.stringify({ [slot.inputProperty]: input }),
					...namespaceMetadata,
				});
			}
		};

		return new TransformStream<ResponsesEvent, LanguageModelV3StreamPart>({
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
						const key = item ? slotKey(event, item) : undefined;
						if (item && key) startSlot(key, item, controller);
						break;
					}

					case "response.output_text.delta": {
						const slot = slots.get(slotKey(event) ?? "");
						const delta = asString(event.delta);
						if (slot?.kind === "text" && delta) controller.enqueue({ type: "text-delta", id: slot.id, delta });
						break;
					}

					case "response.reasoning_text.delta":
					case "response.reasoning_summary_text.delta": {
						const slot = slots.get(slotKey(event) ?? "");
						const delta = asString(event.delta);
						if (slot?.kind === "reasoning" && delta) {
							controller.enqueue({ type: "reasoning-delta", id: slot.id, delta });
						}
						break;
					}

					case "response.function_call_arguments.delta": {
						const slot = slots.get(slotKey(event) ?? "");
						const delta = asString(event.delta);
						if (slot?.kind === "function" && delta) {
							controller.enqueue({ type: "tool-input-delta", id: slot.toolCallId, delta });
						}
						break;
					}

					case "response.custom_tool_call_input.delta":
					case "response.custom_tool_call_input.done": {
						const slot = slots.get(slotKey(event) ?? "");
						if (slot?.kind !== "custom") break;
						const done = type === "response.custom_tool_call_input.done";
						const input = done ? asString(event.input) : slot.buffer.input + (asString(event.delta) ?? "");
						if (input === undefined) break;
						const jsonDelta = appendGrammarInputJsonDelta(slot.buffer, slot.inputProperty, input, done);
						if (jsonDelta)
							controller.enqueue({ type: "tool-input-delta", id: slot.toolCallId, delta: jsonDelta });
						break;
					}

					case "response.output_item.done": {
						const item = asRecord(event.item);
						const key = item ? slotKey(event, item) : undefined;
						if (item && key) endSlot(key, item, controller);
						break;
					}

					case "response.completed":
					case "response.incomplete": {
						const response = asRecord(event.response);
						usage = (response?.usage as ResponsesUsage | undefined) ?? usage;
						servedServiceTier = asString(response?.service_tier) ?? servedServiceTier;
						const status =
							asString(response?.status) ?? (type === "response.incomplete" ? "incomplete" : "completed");
						const incompleteReason = asString(asRecord(response?.incomplete_details)?.reason);
						finishReason = mapResponsesFinishReason(status, hasToolCalls, incompleteReason);
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
							createResponsesStreamError({
								error: error ?? { message: `${request.label} response failed` },
								...request,
							}),
						);
						break;
					}

					case "error": {
						const code = asString(event.code);
						finishReason = { unified: "error", raw: code ?? "error" };
						fail(controller, createResponsesStreamError({ error: event, ...request }));
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
						error: createResponsesPrematureCloseError(request),
					});
				}
			},
		});
	}
}
