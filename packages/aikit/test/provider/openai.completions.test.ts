import { Type } from "@sinclair/typebox";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Message } from "../../src/message/message";
import { Model } from "../../src/model/model";
import { Provider } from "../../src/provider/provider";
import {
	convertMessages,
	streamOpenAICompletions,
	streamSimpleOpenAICompletions,
} from "../../src/provider/providers/openai/completions";
import { validateToolArguments } from "../../src/utils/validation";
import "../utils/env";
import { expectAssistantToolUseMessage } from "../utils/message";
import { calculatorTool } from "../utils/tools";

type MockChunk = null | {
	id?: string;
	choices?: Array<{
		delta: Record<string, unknown>;
		finish_reason: string | null;
		usage?: {
			prompt_tokens?: number;
			completion_tokens?: number;
			prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
			completion_tokens_details?: { reasoning_tokens?: number };
		};
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
		completion_tokens_details?: { reasoning_tokens?: number };
	};
};

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
	chunks: undefined as MockChunk[] | undefined,
	useReal: false,
}));

vi.mock("openai", async () => {
	const actual = await vi.importActual<typeof import("openai")>("openai");

	class WrappedOpenAI {
		private readonly config: ConstructorParameters<typeof actual.default>[0];
		private realClient?: InstanceType<typeof actual.default>;

		constructor(config: ConstructorParameters<typeof actual.default>[0]) {
			this.config = config;
			if (mockState.useReal) {
				this.realClient = new actual.default(config);
			}
		}

		chat = {
			completions: {
				create: async (params: unknown, options?: unknown) => {
					mockState.lastParams = params;

					if (mockState.useReal) {
						this.realClient ??= new actual.default(this.config);
						return this.realClient.chat.completions.create(params as never, options as never);
					}

					const chunks = mockState.chunks ?? [
						{
							choices: [{ delta: {}, finish_reason: "stop" }],
							usage: {
								prompt_tokens: 1,
								completion_tokens: 1,
								prompt_tokens_details: { cached_tokens: 0 },
								completion_tokens_details: { reasoning_tokens: 0 },
							},
						},
					];

					return {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) {
								yield chunk;
							}
						},
					};
				},
			},
		};
	}

	return { default: WrappedOpenAI };
});

const emptyUsage: Message.Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

const defaultCompat: Required<Model.OpenAICompletionsCompat> = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	reasoningEffortMap: {},
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	zaiToolStream: false,
	supportsStrictMode: true,
};

function providerName(providerId: Provider.KnownProvider): string {
	switch (providerId) {
		case Provider.KnownProviderEnum.openai:
			return "OpenAI";
		case Provider.KnownProviderEnum.openrouter:
			return "OpenRouter";
		case Provider.KnownProviderEnum.groq:
			return "Groq";
		case Provider.KnownProviderEnum.zai:
			return "Z.AI";
		case Provider.KnownProviderEnum.xai:
			return "xAI";
		case Provider.KnownProviderEnum.cerebras:
			return "Cerebras";
		case Provider.KnownProviderEnum.githubCopilot:
			return "GitHub Copilot";
		case Provider.KnownProviderEnum.opencode:
			return "OpenCode";
		case Provider.KnownProviderEnum.anthropic:
			return "Anthropic";
	}
}

function providerEnv(providerId: Provider.KnownProvider): string[] {
	switch (providerId) {
		case Provider.KnownProviderEnum.openai:
			return ["OPENAI_API_KEY"];
		case Provider.KnownProviderEnum.openrouter:
			return ["OPENROUTER_API_KEY"];
		case Provider.KnownProviderEnum.groq:
			return ["GROQ_API_KEY"];
		case Provider.KnownProviderEnum.zai:
			return ["ZAI_API_KEY"];
		case Provider.KnownProviderEnum.xai:
			return ["XAI_API_KEY"];
		case Provider.KnownProviderEnum.cerebras:
			return ["CEREBRAS_API_KEY"];
		case Provider.KnownProviderEnum.githubCopilot:
			return ["GITHUB_COPILOT_API_KEY"];
		case Provider.KnownProviderEnum.opencode:
			return ["OPENCODE_API_KEY"];
		case Provider.KnownProviderEnum.anthropic:
			return ["ANTHROPIC_API_KEY"];
	}
}

function providerBaseUrl(providerId: Provider.KnownProvider): string {
	switch (providerId) {
		case Provider.KnownProviderEnum.openrouter:
			return "https://openrouter.ai/api/v1";
		case Provider.KnownProviderEnum.groq:
			return "https://api.groq.com/openai/v1";
		case Provider.KnownProviderEnum.zai:
			return "https://api.z.ai/api/paas/v4";
		case Provider.KnownProviderEnum.xai:
			return "https://api.x.ai/v1";
		case Provider.KnownProviderEnum.cerebras:
			return "https://api.cerebras.ai/v1";
		case Provider.KnownProviderEnum.githubCopilot:
			return "https://api.githubcopilot.com";
		case Provider.KnownProviderEnum.opencode:
			return "https://api.opencode.ai/v1";
		case Provider.KnownProviderEnum.anthropic:
			return "https://api.anthropic.com/v1";
		case Provider.KnownProviderEnum.openai:
			return "https://api.openai.com/v1";
	}
}

function createModel({
	id = "gpt-4o-mini",
	name = "OpenAI Completions Test",
	providerId = Provider.KnownProviderEnum.openai,
	baseUrl = providerBaseUrl(providerId),
	reasoning = true,
	input = ["text"] as Array<"text" | "image">,
	maxTokens = 4096,
	compat,
}: {
	id?: string;
	name?: string;
	providerId?: Provider.KnownProvider;
	baseUrl?: string;
	reasoning?: boolean;
	input?: Array<"text" | "image">;
	maxTokens?: number;
	compat?: Model.OpenAICompletionsCompat;
} = {}): Model.TModel<typeof Model.KnownProtocolEnum.openaiCompletions> {
	return {
		id,
		name,
		provider: {
			id: providerId,
			name: providerName(providerId),
			env: providerEnv(providerId),
		},
		baseUrl,
		reasoning,
		input,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 128000,
		maxTokens,
		protocol: Model.KnownProtocolEnum.openaiCompletions,
		compat,
	};
}

function userMessage(text: string): Message.UserMessage {
	return Message.createUserMessage({
		role: "user",
		time: { created: Date.now() },
		parts: [{ type: "text", text }],
	});
}

function assistantMessage(
	model: Model.Value,
	parts: Message.AssistantMessage["parts"],
	stopReason: Message.AssistantMessage["stopReason"] = "stop",
): Message.AssistantMessage {
	return Message.createAssistantMessage({
		role: "assistant",
		protocol: model.protocol,
		provider: model.provider,
		model: model.id,
		usage: structuredClone(emptyUsage),
		stopReason,
		time: {
			created: Date.now(),
			completed: Date.now(),
		},
		parts,
	});
}

function getText(message: Message.AssistantMessage): string {
	return message.parts
		.filter((part): part is Message.TextContent => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function toToolExecution(toolCall: Message.ToolCall) {
	return {
		callID: toolCall.callID,
		name: toolCall.name,
		rawArgs: toolCall.arguments,
	};
}

function completePendingToolCalls(
	message: Message.AssistantMessage,
	resultContent: Message.ToolCallCompletedPart["result"]["content"],
): Message.AssistantMessage {
	return {
		...structuredClone(message),
		parts: message.parts.map((part) => {
			if (part.type !== "toolCall" || part.status !== "pending") {
				return structuredClone(part);
			}

			return {
				...structuredClone(part),
				status: "completed" as const,
				result: {
					content: structuredClone(resultContent),
					isError: false as const,
				},
			};
		}),
	};
}

function completedToolCall(
	callID: string,
	name: string,
	result: Message.ToolCallCompletedPart["result"],
): Message.ToolCallCompletedPart {
	return {
		type: "toolCall",
		callID,
		name,
		arguments: {},
		status: "completed",
		result,
		time: {
			start: 10,
			end: 11,
		},
	};
}

beforeEach(() => {
	mockState.lastParams = undefined;
	mockState.chunks = undefined;
	mockState.useReal = false;
});

describe("openai completions convertMessages", () => {
	it("batches tool-result images after consecutive completed tool calls", () => {
		const model = createModel({ input: ["text", "image"] });
		const assistant = assistantMessage(
			model,
			[
				completedToolCall("tool-1", "read", {
					content: [
						{ type: "text", text: "Read image file [image/png]" },
						{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
					],
					isError: false,
				}),
				completedToolCall("tool-2", "read", {
					content: [
						{ type: "text", text: "Read image file [image/png]" },
						{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
					],
					isError: false,
				}),
			],
			"toolUse",
		);

		const messages = convertMessages(
			model,
			{
				messages: [userMessage("Read the images"), assistant],
			},
			defaultCompat,
		);

		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool", "user"]);

		const imageMessage = messages[messages.length - 1];
		if (!imageMessage || imageMessage.role !== "user" || !Array.isArray(imageMessage.content)) {
			throw new Error("Expected final message to be a user image payload");
		}

		const imageParts = imageMessage.content.filter((part) => part?.type === "image_url");
		expect(imageParts.length).toBe(2);
	});

	it("normalizes tool call ids, injects synthetic tool results, and bridges follow-up user turns when required", () => {
		const model = createModel();
		const foreignModel: Model.TModel<typeof Model.KnownProtocolEnum.openaiResponses> = {
			...model,
			protocol: Model.KnownProtocolEnum.openaiResponses,
		};
		const compat: Required<Model.OpenAICompletionsCompat> = {
			...defaultCompat,
			requiresToolResultName: true,
			requiresAssistantAfterToolResult: true,
		};

		const messages = convertMessages(
			model,
			{
				systemPrompt: "Use tools when helpful.",
				messages: [
					userMessage("Calculate 25 * 18"),
					assistantMessage(
						foreignModel,
						[
							{
								type: "thinking",
								thinking: "Need calculator",
								thinkingSignature: "reasoning_content",
							},
							{
								type: "toolCall",
								callID: "call_1|A+/=very-long-provider-tool-call-id",
								name: "calculator",
								arguments: { expression: "25 * 18" },
								status: "pending",
								time: {
									start: 10,
									end: 10,
								},
							},
						],
						"toolUse",
					),
					userMessage("Continue"),
				],
			},
			compat,
		);

		expect(messages.map((message) => message.role)).toEqual([
			"developer",
			"user",
			"assistant",
			"tool",
			"assistant",
			"user",
		]);

		const assistantPayload = messages[2] as {
			content?: string | null;
			tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
		};
		expect(assistantPayload.content).toContain("Need calculator");
		expect(assistantPayload.tool_calls?.[0]).toEqual({
			id: "call_1",
			type: "function",
			function: {
				name: "calculator",
				arguments: JSON.stringify({ expression: "25 * 18" }),
			},
		});

		const toolPayload = messages[3] as {
			role: "tool";
			tool_call_id: string;
			name?: string;
			content: string;
		};
		expect(toolPayload.tool_call_id).toBe("call_1");
		expect(toolPayload.name).toBe("calculator");
		expect(toolPayload.content).toContain("No Result Provided");
	});

	it("serializes same-model thinking as assistant text when compat requires it", () => {
		const model = createModel();
		const messages = convertMessages(
			model,
			{
				messages: [
					assistantMessage(model, [
						{
							type: "thinking",
							thinking: "Reason through the arithmetic.",
							thinkingSignature: "reasoning_content",
						},
						{
							type: "text",
							text: "The answer is 450.",
						},
					]),
				],
			},
			{
				...defaultCompat,
				requiresThinkingAsText: true,
			},
		);

		const assistantPayload = messages[0] as unknown as Record<string, unknown>;
		expect(assistantPayload.role).toBe("assistant");
		expect(assistantPayload.content).toBe("Reason through the arithmetic.The answer is 450.");
		expect(assistantPayload.reasoning_content).toBeUndefined();
	});
});

describe("openai completions payload and stream behavior", () => {
	const pingTool = Message.defineTool({
		name: "ping",
		description: "Ping tool",
		parameters: Type.Object({
			ok: Type.Boolean(),
		}),
	});

	it("forwards toolChoice from simple options to the completions payload", async () => {
		const model = createModel();
		let payload: unknown;

		await streamSimpleOpenAICompletions(
			model,
			{
				messages: [userMessage("Call ping with ok=true")],
				tools: [pingTool],
			},
			{
				apiKey: "test",
				toolChoice: "required",
				onPayload: (params: unknown) => {
					payload = params;
				},
			} as unknown as Parameters<typeof streamSimpleOpenAICompletions>[2],
		).result();

		const params = (payload ?? mockState.lastParams) as { tool_choice?: string; tools?: unknown[] };
		expect(params.tool_choice).toBe("required");
		expect(Array.isArray(params.tools)).toBe(true);
		expect(params.tools?.length).toBeGreaterThan(0);
	});

	it("omits strict mode when compat disables it", async () => {
		const model = createModel({
			compat: {
				supportsStrictMode: false,
			},
		});
		let payload: unknown;

		await streamSimpleOpenAICompletions(
			model,
			{
				messages: [userMessage("Call ping with ok=true")],
				tools: [pingTool],
			},
			{
				apiKey: "test",
				onPayload: (params) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as {
			tools?: Array<{ function?: Record<string, unknown> }>;
		};
		const tool = params.tools?.[0]?.function;
		expect(tool).toBeTruthy();
		expect(tool?.strict).toBeUndefined();
		expect("strict" in (tool ?? {})).toBe(false);
	});

	it("maps groq qwen3 reasoning levels through the compat reasoning effort map", async () => {
		const model = createModel({
			id: "qwen/qwen3-32b",
			providerId: Provider.KnownProviderEnum.groq,
		});
		let payload: unknown;

		await streamSimpleOpenAICompletions(
			model,
			{
				messages: [userMessage("Hi")],
			},
			{
				apiKey: "test",
				reasoning: "medium",
				onPayload: (params) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { reasoning_effort?: string };
		expect(params.reasoning_effort).toBe("default");
	});

	it("keeps the normal reasoning_effort for groq models without a compat map override", async () => {
		const model = createModel({
			id: "openai/gpt-oss-20b",
			providerId: Provider.KnownProviderEnum.groq,
		});
		let payload: unknown;

		await streamSimpleOpenAICompletions(
			model,
			{
				messages: [userMessage("Hi")],
			},
			{
				apiKey: "test",
				reasoning: "medium",
				onPayload: (params) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { reasoning_effort?: string };
		expect(params.reasoning_effort).toBe("medium");
	});

	it("respects explicit z.ai tool_stream compat overrides only when tools are present", async () => {
		const model = createModel({
			id: "glm-4.5-air",
			providerId: Provider.KnownProviderEnum.zai,
			compat: {
				zaiToolStream: true,
			},
		});
		let payloadWithTools: unknown;
		let payloadWithoutTools: unknown;

		await streamSimpleOpenAICompletions(
			model,
			{
				messages: [userMessage("Call ping with ok=true")],
				tools: [pingTool],
			},
			{
				apiKey: "test",
				onPayload: (params) => {
					payloadWithTools = params;
				},
			},
		).result();

		await streamSimpleOpenAICompletions(
			model,
			{
				messages: [userMessage("Hi")],
			},
			{
				apiKey: "test",
				onPayload: (params) => {
					payloadWithoutTools = params;
				},
			},
		).result();

		expect((payloadWithTools as { tool_stream?: boolean }).tool_stream).toBe(true);
		expect((payloadWithoutTools as { tool_stream?: boolean }).tool_stream).toBeUndefined();
	});

	it("uses OpenRouter reasoning payloads instead of reasoning_effort", async () => {
		const model = createModel({
			id: "deepseek/deepseek-r1",
			providerId: Provider.KnownProviderEnum.openrouter,
		});
		let payload: unknown;

		await streamSimpleOpenAICompletions(
			model,
			{
				messages: [userMessage("Hi")],
			},
			{
				apiKey: "test",
				reasoning: "high",
				onPayload: (params) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as {
			reasoning?: { effort?: string };
			reasoning_effort?: string;
		};
		expect(params.reasoning).toEqual({ effort: "high" });
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("maps streamed text, reasoning, tool calls, response ids, and usage into assistant output", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl_123",
				choices: [{ delta: { content: "Hello" }, finish_reason: null }],
			},
			{
				id: "chatcmpl_123",
				choices: [{ delta: { content: " world" }, finish_reason: null }],
			},
			{
				id: "chatcmpl_123",
				choices: [{ delta: { reasoning_content: "Need calculator" }, finish_reason: null }],
			},
			{
				id: "chatcmpl_123",
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "tool_1",
									function: {
										name: "calculator",
										arguments: '{"expression":"25 * 18"}',
									},
								},
							],
							reasoning_details: [{ type: "reasoning.encrypted", id: "tool_1", data: "sig_1" }],
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "chatcmpl_123",
				choices: [{ delta: {}, finish_reason: "tool_calls" }],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 11,
					prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 },
					completion_tokens_details: { reasoning_tokens: 2 },
				},
			},
		];

		const model = createModel();
		const stream = streamOpenAICompletions(
			model,
			{
				systemPrompt: "Use tools when helpful.",
				messages: [userMessage("Calculate 25 * 18")],
				tools: [
					Message.defineTool({
						name: "calculator",
						description: "Calculates expressions",
						parameters: Type.Object({
							expression: Type.String(),
						}),
					}),
				],
			},
			{
				apiKey: "test",
			},
		);

		const eventTypes: string[] = [];
		const snapshots: Array<{ type: string; parts: Message.AssistantMessage["parts"]; stopReason?: string }> = [];

		for await (const event of stream) {
			eventTypes.push(event.type);
			if ("partial" in event) {
				snapshots.push({
					type: event.type,
					parts: structuredClone(event.partial.parts),
					stopReason: event.partial.stopReason,
				});
			}
		}

		const message = await stream.result();

		expect(eventTypes).toEqual([
			"start",
			"text.start",
			"text.delta",
			"text.delta",
			"text.end",
			"thinking.start",
			"thinking.delta",
			"thinking.end",
			"toolcall.start",
			"toolcall.delta",
			"toolcall.end",
			"done",
		]);

		expect(message.responseId).toBe("chatcmpl_123");
		expect(message.stopReason).toBe("toolUse");
		expect(message.parts[0]).toEqual({ type: "text", text: "Hello world" });
		expect(message.parts[1]).toEqual({
			type: "thinking",
			thinking: "Need calculator",
			thinkingSignature: "reasoning_content",
		});
		expect(message.parts[2]).toMatchObject({
			type: "toolCall",
			callID: "tool_1",
			name: "calculator",
			arguments: { expression: "25 * 18" },
			status: "pending",
			thoughtSignature: JSON.stringify({ type: "reasoning.encrypted", id: "tool_1", data: "sig_1" }),
		});
		expect(message.usage.input).toBe(6);
		expect(message.usage.output).toBe(13);
		expect(message.usage.cacheRead).toBe(3);
		expect(message.usage.cacheWrite).toBe(1);
		expect(message.usage.totalTokens).toBe(23);

		const textDeltaSnapshot = snapshots.find((snapshot) => snapshot.type === "text.delta");
		const thinkingEndSnapshot = snapshots.find((snapshot) => snapshot.type === "thinking.end");
		const toolCallEndSnapshot = snapshots.find((snapshot) => snapshot.type === "toolcall.end");

		expect(textDeltaSnapshot?.parts[0]).toMatchObject({ type: "text", text: "Hello world" });
		expect(thinkingEndSnapshot?.parts[1]).toMatchObject({
			type: "thinking",
			thinking: "Need calculator",
			thinkingSignature: "reasoning_content",
		});
		expect(toolCallEndSnapshot?.parts[2]).toMatchObject({
			type: "toolCall",
			callID: "tool_1",
			name: "calculator",
			arguments: { expression: "25 * 18" },
		});
	});

	it("maps non-standard finish_reason values to stopReason=error", async () => {
		mockState.chunks = [
			{
				choices: [{ delta: { content: "partial" }, finish_reason: null }],
			},
			{
				choices: [{ delta: {}, finish_reason: "network_error" }],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const response = await streamSimpleOpenAICompletions(
			createModel({
				id: "glm-5",
				providerId: Provider.KnownProviderEnum.zai,
			}),
			{
				messages: [userMessage("Hi")],
			},
			{ apiKey: "test" },
		).result();

		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toBe("Provider finish_reason: network_error");
	});

	it("ignores null stream chunks and still returns the final response id and usage", async () => {
		mockState.chunks = [
			null,
			{
				id: "chatcmpl-test",
				choices: [{ delta: { content: "OK" }, finish_reason: null }],
			},
			{
				id: "chatcmpl-test",
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 3,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const response = await streamSimpleOpenAICompletions(
			createModel(),
			{
				messages: [userMessage("Reply with exactly OK")],
			},
			{ apiKey: "test" },
		).result();

		expect(response.stopReason).toBe("stop");
		expect(response.errorMessage).toBeUndefined();
		expect(response.responseId).toBe("chatcmpl-test");
		expect(response.usage.totalTokens).toBe(4);
		expect(response.parts).toEqual([{ type: "text", text: "OK" }]);
	});

	it("preserves cache_write_tokens from top-level chunk usage", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-cache-write",
				choices: [{ delta: { content: "OK" }, finish_reason: null }],
			},
			{
				id: "chatcmpl-cache-write",
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 5,
					prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 30 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const response = await streamSimpleOpenAICompletions(
			createModel(),
			{
				messages: [userMessage("Reply with exactly OK")],
			},
			{ apiKey: "test" },
		).result();

		expect(response.usage.input).toBe(50);
		expect(response.usage.cacheRead).toBe(20);
		expect(response.usage.cacheWrite).toBe(30);
		expect(response.usage.totalTokens).toBe(105);
	});

	it("preserves cache_write_tokens from choice-level usage fallbacks", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-cache-write-choice",
				choices: [{ delta: { content: "OK" }, finish_reason: null }],
			},
			{
				id: "chatcmpl-cache-write-choice",
				choices: [
					{
						delta: {},
						finish_reason: "stop",
						usage: {
							prompt_tokens: 100,
							completion_tokens: 5,
							prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 30 },
							completion_tokens_details: { reasoning_tokens: 0 },
						},
					},
				],
			},
		];

		const response = await streamSimpleOpenAICompletions(
			createModel(),
			{
				messages: [userMessage("Reply with exactly OK")],
			},
			{ apiKey: "test" },
		).result();

		expect(response.usage.input).toBe(50);
		expect(response.usage.cacheRead).toBe(20);
		expect(response.usage.cacheWrite).toBe(30);
		expect(response.usage.totalTokens).toBe(105);
	});
});

const describeIfOpenAI = process.env.OPENAI_API_KEY ? describe : describe.skip;

describeIfOpenAI("openai completions live integration", () => {
	it("handles a real tool-calling roundtrip with a completed tool result", async () => {
		mockState.useReal = true;

		const model = createModel({
			id: "gpt-4o-mini",
			name: "gpt-4o-mini",
			providerId: Provider.KnownProviderEnum.openai,
			baseUrl: "https://api.openai.com/v1",
			input: ["text"],
			reasoning: false,
		});
		const context: Message.Context = {
			systemPrompt: "You are a helpful assistant. Always use the calculator tool for arithmetic requests.",
			messages: [userMessage("Please calculate 25 * 18 using the calculator tool.")],
			tools: [calculatorTool],
		};

		const firstResponse = await streamSimpleOpenAICompletions(model, context, {
			apiKey: process.env.OPENAI_API_KEY,
		}).result();

		const toolCalls = expectAssistantToolUseMessage(firstResponse);
		const args = validateToolArguments(calculatorTool, toToolExecution(toolCalls[0]!));

		expect(args.expression).toContain("25");
		expect(args.expression).toContain("18");

		const completedToolMessage = completePendingToolCalls(firstResponse, [{ type: "text", text: "450" }]);
		const finalResponse = await streamSimpleOpenAICompletions(
			model,
			{
				...context,
				messages: [
					context.messages[0]!,
					completedToolMessage,
					userMessage("Now provide the final answer using the tool result only."),
				],
			},
			{
				apiKey: process.env.OPENAI_API_KEY,
			},
		).result();

		expect(finalResponse.stopReason).toBe("stop");
		expect(finalResponse.errorMessage).toBeUndefined();
		expect(getText(finalResponse)).toContain("450");
	}, 30000);

	it("filters real orphaned tool calls without a corresponding tool result", async () => {
		mockState.useReal = true;

		const model = createModel({
			id: "gpt-4o-mini",
			name: "gpt-4o-mini",
			providerId: Provider.KnownProviderEnum.openai,
			baseUrl: "https://api.openai.com/v1",
			input: ["text"],
			reasoning: false,
		});
		const context: Message.Context = {
			systemPrompt: "You are a helpful assistant. Use the calculator tool when asked to perform calculations.",
			messages: [userMessage("Please calculate 25 * 18 using the calculator tool.")],
			tools: [calculatorTool],
		};

		const firstResponse = await streamSimpleOpenAICompletions(model, context, {
			apiKey: process.env.OPENAI_API_KEY,
		}).result();

		expectAssistantToolUseMessage(firstResponse);

		const secondResponse = await streamSimpleOpenAICompletions(
			model,
			{
				...context,
				messages: [context.messages[0]!, firstResponse, userMessage("Never mind, just tell me what is 2+2?")],
			},
			{
				apiKey: process.env.OPENAI_API_KEY,
			},
		).result();

		expect(secondResponse.stopReason).not.toBe("error");
		expect(secondResponse.parts.length).toBeGreaterThan(0);
		expect(
			getText(secondResponse).length || secondResponse.parts.filter((part) => part.type === "toolCall").length,
		).toBeGreaterThan(0);
		expect(["stop", "toolUse"]).toContain(secondResponse.stopReason);
	}, 30000);

	it("emits text stream events in order for a real OpenAI completions request", async () => {
		mockState.useReal = true;

		const stream = streamSimpleOpenAICompletions(
			createModel({
				id: "gpt-4o-mini",
				name: "gpt-4o-mini",
				providerId: Provider.KnownProviderEnum.openai,
				baseUrl: "https://api.openai.com/v1",
				input: ["text"],
				reasoning: false,
			}),
			{
				systemPrompt: "Reply with the requested text only.",
				messages: [userMessage("Reply with exactly: OpenAI stream order test successful")],
			},
			{
				apiKey: process.env.OPENAI_API_KEY,
			},
		);

		const eventTypes: string[] = [];

		for await (const event of stream) {
			eventTypes.push(event.type);
		}

		const response = await stream.result();
		const firstTextStart = eventTypes.indexOf("text.start");
		const firstTextDelta = eventTypes.indexOf("text.delta");
		const firstTextEnd = eventTypes.indexOf("text.end");

		expect(response.stopReason).toBe("stop");
		expect(response.errorMessage).toBeUndefined();
		expect(eventTypes[0]).toBe("start");
		expect(eventTypes.at(-1)).toBe("done");
		expect(eventTypes.includes("error")).toBe(false);
		expect(firstTextStart).toBeGreaterThan(0);
		expect(firstTextDelta).toBeGreaterThan(firstTextStart);
		expect(firstTextEnd).toBeGreaterThan(firstTextDelta);

		const text = response.parts
			.filter((part): part is Message.TextContent => part.type === "text")
			.map((part) => part.text)
			.join("");
		expect(text).toContain("OpenAI stream order test successful");
	}, 30000);

	it("runs a real OpenAI chat completions request with credentials from .env.local", async () => {
		mockState.useReal = true;

		const response = await streamSimpleOpenAICompletions(
			createModel({
				id: "gpt-4o-mini",
				name: "gpt-4o-mini",
				providerId: Provider.KnownProviderEnum.openai,
				baseUrl: "https://api.openai.com/v1",
				input: ["text"],
			}),
			{
				systemPrompt: "Reply with the requested text only.",
				messages: [userMessage("Reply with exactly: OpenAI completions live test successful")],
			},
			{
				apiKey: process.env.OPENAI_API_KEY,
			},
		).result();

		expect(response.stopReason).toBe("stop");
		expect(response.responseId).toBeTruthy();

		const text = response.parts
			.filter((part): part is Message.TextContent => part.type === "text")
			.map((part) => part.text)
			.join("");
		expect(text).toContain("OpenAI completions live test successful");
	}, 30000);
});
