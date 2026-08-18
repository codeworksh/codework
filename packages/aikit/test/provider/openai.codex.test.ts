/**
 * Vercel AI SDK provider conformance tests for the OpenAI Codex provider.
 * All requests are served by a mocked fetch; no network access.
 */
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { APICallError, LoadAPIKeyError, NoSuchModelError } from "@ai-sdk/provider";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
	AI_SDK_PACKAGE_TO_PROTOCOL,
	isAISDKPackage,
	loadProviderFactory,
	protocolForPackage,
} from "../../src/llm/registry.ts";
import { getOpenAICodexApiKey, type OpenAICodexOAuthCredentials } from "../../src/oauth/openai/codex.ts";
import {
	appendOpenAICodexGrammarInputJsonDelta,
	convertToOpenAICodexPrompt,
	createOpenAICodex,
	joinToolCallId,
	OpenAICodexLanguageModel,
	resolveOpenAICodexUrl,
	splitToolCallId,
} from "../../src/providers/openai-codex/index.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeJwt(payload: Record<string, unknown>): string {
	const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

const TEST_ACCOUNT_ID = "acct_test_123";
const TEST_API_KEY = makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: TEST_ACCOUNT_ID } });

function sseBody(events: Array<Record<string, unknown>>): string {
	return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
	return new Response(sseBody(events), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

type FetchCall = { url: string; init: RequestInit & { headers: Record<string, string> } };

function createMockFetch(responses: Response | Response[]): {
	fetch: typeof globalThis.fetch;
	calls: FetchCall[];
	body: (index?: number) => Record<string, unknown>;
} {
	const queue = Array.isArray(responses) ? [...responses] : [responses];
	const calls: FetchCall[] = [];
	const mock = (async (url: RequestInfo | URL, init?: RequestInit) => {
		const target = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
		calls.push({ url: target, init: (init ?? {}) as FetchCall["init"] });
		const next = queue.shift();
		if (!next) throw new Error("Mock fetch queue exhausted");
		return next;
	}) as typeof globalThis.fetch;

	return {
		fetch: mock,
		calls,
		body: (index = 0) => {
			const raw = calls[index]?.init.body;
			const json =
				typeof raw === "string"
					? raw
					: new TextDecoder().decode(zstdDecompressSync(raw as Uint8Array<ArrayBuffer>));
			return JSON.parse(json) as Record<string, unknown>;
		},
	};
}

async function readAllParts(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<LanguageModelV3StreamPart[]> {
	const parts: LanguageModelV3StreamPart[] = [];
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value);
	}
	return parts;
}

const userPrompt: LanguageModelV3Prompt = [
	{ role: "system", content: "You are concise." },
	{ role: "user", content: [{ type: "text", text: "Hello" }] },
];

const deferredToolsPrompt: LanguageModelV3Prompt = [
	{ role: "user", content: [{ type: "text", text: "Use the tools" }] },
	{
		role: "assistant",
		content: [{ type: "tool-call", toolCallId: "call_1|fc_1", toolName: "base_tool", input: {} }],
	},
	{
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: "call_1|fc_1",
				toolName: "base_tool",
				output: { type: "text", value: "done" },
				providerOptions: { "openai-codex": { addedToolNames: ["late_tool"] } },
			},
		],
	},
	{ role: "user", content: [{ type: "text", text: "Continue" }] },
];

const deferredTools = [
	{
		type: "function" as const,
		name: "base_tool",
		description: "Base tool",
		inputSchema: { type: "object", properties: {} },
	},
	{
		type: "function" as const,
		name: "late_tool",
		description: "Late tool",
		inputSchema: { type: "object", properties: { value: { type: "string" } } },
	},
];

const textEvents: Array<Record<string, unknown>> = [
	{ type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
	{
		type: "response.output_item.added",
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	},
	{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hello" },
	{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: " world" },
	{
		type: "response.output_item.done",
		item: {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Hello world", annotations: [] }],
		},
	},
	{
		type: "response.completed",
		response: {
			id: "resp_1",
			model: "gpt-5.4",
			status: "completed",
			usage: {
				input_tokens: 100,
				output_tokens: 20,
				total_tokens: 120,
				input_tokens_details: { cached_tokens: 40 },
				output_tokens_details: { reasoning_tokens: 5 },
			},
		},
	},
];

// ── env hygiene ──────────────────────────────────────────────────────────────

let savedEnvKey: string | undefined;

beforeEach(() => {
	savedEnvKey = process.env.OPENAI_CODEX_API_KEY;
	delete process.env.OPENAI_CODEX_API_KEY;
});

afterEach(() => {
	if (savedEnvKey === undefined) delete process.env.OPENAI_CODEX_API_KEY;
	else process.env.OPENAI_CODEX_API_KEY = savedEnvKey;
});

// ── provider factory conformance ─────────────────────────────────────────────

describe("createOpenAICodex provider", () => {
	it("implements the ProviderV3 specification", () => {
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY });
		expect(provider.specificationVersion).toBe("v3");

		const model = provider("gpt-5.4");
		expect(model).toBeInstanceOf(OpenAICodexLanguageModel);
		expect(model.specificationVersion).toBe("v3");
		expect(model.provider).toBe("openai-codex");
		expect(model.modelId).toBe("gpt-5.4");
	});

	it("exposes languageModel and responses methods", () => {
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY });
		expect(provider.languageModel("gpt-5.5")).toBeInstanceOf(OpenAICodexLanguageModel);
		expect(provider.responses("gpt-5.5")).toBeInstanceOf(OpenAICodexLanguageModel);
	});

	it("cannot be invoked with the new keyword", () => {
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY });
		expect(() => new (provider as unknown as new (modelId: string) => unknown)("gpt-5.4")).toThrow(/new keyword/);
	});

	it("throws NoSuchModelError for non-language models", () => {
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY });
		expect(() => provider.embeddingModel("text-embedding-3-small")).toThrow(NoSuchModelError);
		expect(() => provider.imageModel("dall-e-3")).toThrow(NoSuchModelError);
	});

	it("reports no natively supported URLs", () => {
		const model = createOpenAICodex({ apiKey: TEST_API_KEY })("gpt-5.4");
		expect(model.supportedUrls).toEqual({});
	});
});

// ── auth ─────────────────────────────────────────────────────────────────────

describe("authentication", () => {
	it("fails with LoadAPIKeyError when no API key is available", async () => {
		const { fetch } = createMockFetch(sseResponse(textEvents));
		const model = createOpenAICodex({ fetch })("gpt-5.4");
		await expect(model.doStream({ prompt: userPrompt })).rejects.toThrow(LoadAPIKeyError);
	});

	it("reads the API key from OPENAI_CODEX_API_KEY", async () => {
		process.env.OPENAI_CODEX_API_KEY = TEST_API_KEY;
		const { fetch, calls } = createMockFetch(sseResponse(textEvents));
		const model = createOpenAICodex({ fetch })("gpt-5.4");
		await model.doStream({ prompt: userPrompt });

		expect(calls[0]?.init.headers.Authorization).toBe(`Bearer ${TEST_API_KEY}`);
	});

	it("supports an async apiKey resolver", async () => {
		const { fetch, calls } = createMockFetch(sseResponse(textEvents));
		const model = createOpenAICodex({ apiKey: async () => TEST_API_KEY, fetch })("gpt-5.4");
		await model.doStream({ prompt: userPrompt });

		expect(calls[0]?.init.headers.Authorization).toBe(`Bearer ${TEST_API_KEY}`);
	});

	it("fails when the account id cannot be extracted from the token", async () => {
		const { fetch } = createMockFetch(sseResponse(textEvents));
		const model = createOpenAICodex({ apiKey: "not-a-jwt", fetch })("gpt-5.4");
		await expect(model.doStream({ prompt: userPrompt })).rejects.toThrow(/account id/);
	});

	it("accepts an explicit accountId for opaque tokens", async () => {
		const { fetch, calls } = createMockFetch(sseResponse(textEvents));
		const model = createOpenAICodex({ apiKey: "opaque-token", accountId: "acct_explicit", fetch })("gpt-5.4");
		await model.doStream({ prompt: userPrompt });

		expect(calls[0]?.init.headers["chatgpt-account-id"]).toBe("acct_explicit");
	});
});

// ── request shape ────────────────────────────────────────────────────────────

describe("request", () => {
	it("posts to the codex responses endpoint with Codex headers", async () => {
		const { fetch, calls } = createMockFetch(sseResponse(textEvents));
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY, sessionId: "session-1", fetch });
		await provider("gpt-5.4").doStream({ prompt: userPrompt });

		const call = calls[0]!;
		expect(call.url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(call.init.method).toBe("POST");
		expect(call.init.headers).toMatchObject({
			Authorization: `Bearer ${TEST_API_KEY}`,
			"chatgpt-account-id": TEST_ACCOUNT_ID,
			"OpenAI-Beta": "responses=experimental",
			originator: "codework",
			accept: "text/event-stream",
			"content-type": "application/json",
			"session-id": "session-1",
			"x-client-request-id": "session-1",
		});
	});

	it("merges provider and per-call headers", async () => {
		const { fetch, calls } = createMockFetch(sseResponse(textEvents));
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY, headers: { "x-provider": "a" }, fetch });
		await provider("gpt-5.4").doStream({ prompt: userPrompt, headers: { "x-call": "b" } });

		expect(calls[0]?.init.headers).toMatchObject({ "x-provider": "a", "x-call": "b" });
	});

	it("builds the Codex request body with defaults", async () => {
		const { fetch, body } = createMockFetch(sseResponse(textEvents));
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY, fetch });
		await provider("gpt-5.4").doStream({ prompt: userPrompt, temperature: 0.2 });

		expect(body()).toMatchObject({
			model: "gpt-5.4",
			stream: true,
			store: false,
			instructions: "You are concise.",
			input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
			tool_choice: "auto",
			parallel_tool_calls: true,
			include: ["reasoning.encrypted_content"],
			text: { verbosity: "low" },
			temperature: 0.2,
		});
	});

	it("drops maxOutputTokens with a warning; the Codex backend rejects it", async () => {
		const { fetch, body } = createMockFetch(sseResponse(textEvents));
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY, fetch });
		const { stream } = await provider("gpt-5.4").doStream({ prompt: userPrompt, maxOutputTokens: 4096 });
		const parts = await readAllParts(stream);

		expect(body().max_output_tokens).toBeUndefined();
		const start = parts.find((part) => part.type === "stream-start");
		const features =
			start?.type === "stream-start"
				? start.warnings.map((warning) => (warning.type === "unsupported" ? warning.feature : warning.type))
				: [];
		expect(features).toContain("maxOutputTokens");
	});

	it("maps tools and tool choice", async () => {
		const { fetch, body } = createMockFetch(sseResponse(textEvents));
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY, fetch });
		await provider("gpt-5.4").doStream({
			prompt: userPrompt,
			tools: [
				{
					type: "function",
					name: "math_operation",
					description: "Do math",
					inputSchema: { type: "object", properties: { a: { type: "number" } } },
				},
			],
			toolChoice: { type: "required" },
		});

		expect(body()).toMatchObject({
			tool_choice: "required",
			tools: [
				{
					type: "function",
					name: "math_operation",
					description: "Do math",
					parameters: { type: "object", properties: { a: { type: "number" } } },
					strict: null,
				},
			],
		});
	});

	it("maps grammar metadata to native Codex custom tools", async () => {
		const { fetch, body } = createMockFetch(sseResponse(textEvents));
		await createOpenAICodex({ apiKey: TEST_API_KEY, fetch })("gpt-5.6-luna").doStream({
			prompt: userPrompt,
			tools: [
				{
					type: "function",
					name: "sample",
					description: "Generate a sample",
					inputSchema: {
						type: "object",
						properties: { payload: { type: "string" } },
						required: ["payload"],
					},
					providerOptions: {
						"openai-codex": {
							grammar: {
								type: "grammar",
								format: "lark",
								definition: "start: /[a-z]+/",
								inputProperty: "payload",
							},
						},
					},
				},
			],
		});

		expect(body().tools).toEqual([
			{
				type: "custom",
				name: "sample",
				description: "Generate a sample",
				format: { type: "grammar", syntax: "lark", definition: "start: /[a-z]+/" },
			},
		]);
	});

	it("keeps deferred grammar tools native inside additional_tools", async () => {
		const { fetch, body } = createMockFetch(sseResponse(textEvents));
		await createOpenAICodex({ apiKey: TEST_API_KEY, fetch })("gpt-5.6-luna").doStream({
			prompt: deferredToolsPrompt,
			tools: [
				deferredTools[0]!,
				{
					...deferredTools[1]!,
					providerOptions: {
						"openai-codex": {
							grammar: {
								type: "grammar",
								format: "regex",
								definition: "[a-z]+",
								inputProperty: "value",
							},
						},
					},
				},
			],
		});

		const additionalTools = (body().input as Array<Record<string, unknown>>).find(
			(item) => item.type === "additional_tools",
		);
		expect(additionalTools?.tools).toEqual([
			expect.objectContaining({
				type: "custom",
				name: "late_tool",
				format: { type: "grammar", syntax: "regex", definition: "[a-z]+" },
			}),
		]);
	});

	it("loads GPT-5.6 Codex deferred tools through additional_tools", async () => {
		const { fetch, body } = createMockFetch(sseResponse(textEvents));
		await createOpenAICodex({ apiKey: TEST_API_KEY, fetch })("gpt-5.6-luna").doStream({
			prompt: deferredToolsPrompt,
			tools: deferredTools,
		});

		const payload = body();
		expect(payload.tools).toMatchObject([{ name: "base_tool" }]);
		expect(payload.input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "additional_tools",
					role: "developer",
					tools: [expect.objectContaining({ name: "late_tool" })],
				}),
			]),
		);
		expect((payload.input as Array<{ type?: string }>).some((item) => item.type === "tool_search_output")).toBe(
			false,
		);
	});

	it("falls back to transcript tool_search items for GPT-5.4 Codex", async () => {
		const { fetch, body } = createMockFetch(sseResponse(textEvents));
		await createOpenAICodex({ apiKey: TEST_API_KEY, fetch })("gpt-5.4").doStream({
			prompt: deferredToolsPrompt,
			tools: deferredTools,
		});

		const payload = body();
		expect(payload.tools).toMatchObject([{ name: "base_tool" }]);
		const input = payload.input as Array<Record<string, unknown>>;
		const searchCall = input.find((item) => item.type === "tool_search_call");
		const searchOutput = input.find((item) => item.type === "tool_search_output");
		expect(searchCall).toMatchObject({ execution: "client", status: "completed" });
		expect(searchOutput).toMatchObject({
			call_id: searchCall?.call_id,
			execution: "client",
			status: "completed",
			tools: [expect.objectContaining({ name: "late_tool", defer_loading: true })],
		});
		expect(input.some((item) => item.type === "additional_tools")).toBe(false);
	});

	it("keeps all tools top-level when the Codex model has no deferred-tool support", async () => {
		const { fetch, body } = createMockFetch(sseResponse(textEvents));
		await createOpenAICodex({ apiKey: TEST_API_KEY, fetch })("gpt-5.3-codex-spark").doStream({
			prompt: deferredToolsPrompt,
			tools: deferredTools,
		});

		const payload = body();
		expect(payload.tools).toMatchObject([{ name: "base_tool" }, { name: "late_tool" }]);
		expect(
			(payload.input as Array<{ type?: string }>).some(
				(item) => item.type === "additional_tools" || item.type === "tool_search_output",
			),
		).toBe(false);
	});

	it("honors explicit deferred-tool compatibility overrides", async () => {
		const { fetch, body } = createMockFetch(sseResponse(textEvents));
		await createOpenAICodex({
			apiKey: TEST_API_KEY,
			fetch,
			compat: { supportsToolSearch: false, supportsAdditionalTools: false },
		})("gpt-5.6-luna").doStream({ prompt: deferredToolsPrompt, tools: deferredTools });

		expect(body().tools).toMatchObject([{ name: "base_tool" }, { name: "late_tool" }]);
	});

	it("applies openai-codex provider options", async () => {
		const { fetch, body } = createMockFetch(sseResponse(textEvents));
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY, fetch });
		await provider("gpt-5.4").doStream({
			prompt: userPrompt,
			providerOptions: {
				"openai-codex": {
					reasoningEffort: "high",
					reasoningSummary: "detailed",
					textVerbosity: "medium",
					serviceTier: "flex",
					promptCacheKey: "cache-key-1",
				},
			},
		});

		expect(body()).toMatchObject({
			reasoning: { effort: "high", summary: "detailed" },
			text: { verbosity: "medium" },
			service_tier: "flex",
			prompt_cache_key: "cache-key-1",
		});
	});

	it("forwards max reasoning effort for GPT-5.6 Codex models", async () => {
		const { fetch, body } = createMockFetch(sseResponse(textEvents));
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY, fetch });
		await provider("gpt-5.6-sol").doStream({
			prompt: userPrompt,
			providerOptions: { "openai-codex": { reasoningEffort: "max" } },
		});

		expect(body().reasoning).toEqual({ effort: "max", summary: "auto" });
	});

	it("defaults the prompt cache key to the provider sessionId", async () => {
		const { fetch, body } = createMockFetch(sseResponse(textEvents));
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY, sessionId: "session-9", fetch });
		await provider("gpt-5.4").doStream({ prompt: userPrompt });

		expect(body().prompt_cache_key).toBe("session-9");
	});

	it("clamps Codex cache-affinity values to 64 Unicode characters", async () => {
		const sessionId = `${"🙂".repeat(64)}overflow`;
		const { fetch, body, calls } = createMockFetch(sseResponse(textEvents));
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY, sessionId, fetch });
		await provider("gpt-5.4").doStream({ prompt: userPrompt });

		const expected = "🙂".repeat(64);
		expect(body().prompt_cache_key).toBe(expected);
		expect(calls[0]?.init.headers["session-id"]).toBe(expected);
		expect(calls[0]?.init.headers["x-client-request-id"]).toBe(expected);
	});

	it("zstd-compresses Codex SSE request bodies when Node supports it", async () => {
		const { fetch, body, calls } = createMockFetch(sseResponse(textEvents));
		await createOpenAICodex({ apiKey: TEST_API_KEY, fetch })("gpt-5.4").doStream({ prompt: userPrompt });

		expect(calls[0]?.init.headers["content-encoding"]).toBe("zstd");
		expect(body()).toMatchObject({ model: "gpt-5.4", stream: true });
	});

	it("warns on unsupported call options instead of sending them", async () => {
		const { fetch, body } = createMockFetch(sseResponse(textEvents));
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY, fetch });
		const { stream } = await provider("gpt-5.4").doStream({
			prompt: userPrompt,
			topP: 0.5,
			topK: 10,
			presencePenalty: 0.1,
			frequencyPenalty: 0.1,
			seed: 42,
			stopSequences: ["stop"],
			responseFormat: { type: "json" },
		});

		const parts = await readAllParts(stream);
		const start = parts.find((part) => part.type === "stream-start");
		expect(start?.type).toBe("stream-start");
		const features =
			start?.type === "stream-start"
				? start.warnings.map((warning) => (warning.type === "unsupported" ? warning.feature : warning.type))
				: [];
		expect(features).toEqual(
			expect.arrayContaining([
				"topP",
				"topK",
				"presencePenalty",
				"frequencyPenalty",
				"seed",
				"stopSequences",
				"responseFormat",
			]),
		);

		const requestBody = body();
		expect(requestBody.top_p).toBeUndefined();
		expect(requestBody.stop).toBeUndefined();
	});

	it("honors custom base URLs with and without the codex suffix", () => {
		expect(resolveOpenAICodexUrl(undefined)).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(resolveOpenAICodexUrl("https://example.com/backend-api")).toBe(
			"https://example.com/backend-api/codex/responses",
		);
		expect(resolveOpenAICodexUrl("https://example.com/backend-api/codex")).toBe(
			"https://example.com/backend-api/codex/responses",
		);
		expect(resolveOpenAICodexUrl("https://example.com/backend-api/codex/responses")).toBe(
			"https://example.com/backend-api/codex/responses",
		);
		expect(resolveOpenAICodexUrl("https://example.com/base/")).toBe("https://example.com/base/codex/responses");
	});
});

// ── prompt conversion ────────────────────────────────────────────────────────

describe("prompt conversion", () => {
	it("converts system, user, assistant, and tool messages", () => {
		const prompt: LanguageModelV3Prompt = [
			{ role: "system", content: "First." },
			{ role: "system", content: "Second." },
			{ role: "user", content: [{ type: "text", text: "Compute 2+2" }] },
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "let me think" },
					{ type: "tool-call", toolCallId: "call_1|fc_1", toolName: "math", input: { a: 2, b: 2 } },
					{ type: "text", text: "Calling the tool." },
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call_1|fc_1",
						toolName: "math",
						output: { type: "text", value: "4" },
					},
				],
			},
		];

		const { instructions, input } = convertToOpenAICodexPrompt(prompt);

		expect(instructions).toBe("First.\n\nSecond.");
		expect(input).toHaveLength(4);
		expect(input[0]).toEqual({ role: "user", content: [{ type: "input_text", text: "Compute 2+2" }] });
		expect(input[1]).toEqual({
			type: "function_call",
			id: "fc_1",
			call_id: "call_1",
			name: "math",
			arguments: JSON.stringify({ a: 2, b: 2 }),
		});
		expect(input[2]).toMatchObject({
			type: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Calling the tool.", annotations: [] }],
		});
		expect(input[3]).toEqual({ type: "function_call_output", call_id: "call_1", output: "4" });
	});

	it("replays signed reasoning, assistant message ids, and deferred-tool namespaces", () => {
		const signedReasoning = {
			type: "reasoning" as const,
			id: "rs_1",
			summary: [],
			encrypted_content: "encrypted",
		};
		const { input } = convertToOpenAICodexPrompt([
			{
				role: "assistant",
				content: [
					{
						type: "reasoning",
						text: "summary",
						providerOptions: {
							"openai-codex": { reasoningItem: JSON.stringify(signedReasoning) },
						},
					},
					{
						type: "text",
						text: "answer",
						providerOptions: { "openai-codex": { messageId: "msg_1" } },
					},
					{
						type: "tool-call",
						toolCallId: "call_1|fc_1",
						toolName: "search",
						input: { query: "docs" },
						providerOptions: { "openai-codex": { namespace: "workspace" } },
					},
				],
			},
		]);

		expect(input).toEqual([
			signedReasoning,
			{
				type: "message",
				role: "assistant",
				id: "msg_1",
				content: [{ type: "output_text", text: "answer", annotations: [] }],
				status: "completed",
			},
			{
				type: "function_call",
				id: "fc_1",
				call_id: "call_1",
				name: "search",
				arguments: '{"query":"docs"}',
				namespace: "workspace",
			},
		]);
	});

	it("converts image file parts to input_image entries", () => {
		const { input } = convertToOpenAICodexPrompt([
			{
				role: "user",
				content: [
					{ type: "file", mediaType: "image/png", data: "aGVsbG8=" },
					{ type: "file", mediaType: "image/jpeg", data: new URL("https://example.com/cat.jpg") },
				],
			},
		]);

		expect(input[0]).toEqual({
			role: "user",
			content: [
				{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "auto" },
				{ type: "input_image", image_url: "https://example.com/cat.jpg", detail: "auto" },
			],
		});
	});

	it("converts AI SDK V4 image file data to input_image entries", () => {
		const { input } = convertToOpenAICodexPrompt([
			{
				role: "user",
				content: [
					{
						type: "file",
						mediaType: "image/png",
						data: { type: "data", data: "aGVsbG8=" },
					},
				],
			},
		]);

		expect(input[0]).toEqual({
			role: "user",
			content: [{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "auto" }],
		});
	});

	it("defaults instructions when no system message exists", () => {
		const { instructions } = convertToOpenAICodexPrompt([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
		expect(instructions).toBe("You are a helpful assistant.");
	});

	it("round-trips composite tool call ids", () => {
		expect(splitToolCallId(joinToolCallId("call_9", "fc_9"))).toEqual({ callId: "call_9", itemId: "fc_9" });
		expect(splitToolCallId("plain_id")).toEqual({ callId: "plain_id", itemId: "plain_id" });
	});

	it("replays native custom tool calls and results from ordinary AI SDK tool parts", () => {
		const grammarToolInputProperties = new Map([["sample", "payload"]]);
		const { input } = convertToOpenAICodexPrompt(
			[
				{
					role: "assistant",
					content: [
						{
							type: "tool-call",
							toolCallId: "call_1|ctc_1",
							toolName: "sample",
							input: { payload: "abc" },
							providerOptions: { "openai-codex": { namespace: "grammar" } },
						},
					],
				},
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "call_1|ctc_1",
							toolName: "sample",
							output: { type: "text", value: "accepted" },
						},
					],
				},
			],
			{ grammarToolInputProperties },
		);

		expect(input).toEqual([
			{
				type: "custom_tool_call",
				id: "ctc_1",
				call_id: "call_1",
				name: "sample",
				input: "abc",
				namespace: "grammar",
			},
			{ type: "custom_tool_call_output", call_id: "call_1", output: "accepted" },
		]);
	});

	it("produces append-only JSON deltas for raw grammar input", () => {
		const buffer = { input: "", started: false, closed: false };
		expect(appendOpenAICodexGrammarInputJsonDelta(buffer, "payload", 'a"', false)).toBe('{"payload":"a\\"');
		expect(appendOpenAICodexGrammarInputJsonDelta(buffer, "payload", 'a"\nb', true)).toBe('\\nb"}');
		expect(appendOpenAICodexGrammarInputJsonDelta(buffer, "payload", 'a"\nb', true)).toBeUndefined();
	});

	it("omits Responses item ids for non-composite and cross-model tool calls", () => {
		const { input } = convertToOpenAICodexPrompt([
			{
				role: "assistant",
				content: [
					{ type: "tool-call", toolCallId: "plain_id", toolName: "first", input: {} },
					{
						type: "tool-call",
						toolCallId: "call_2|fc_2",
						toolName: "second",
						input: {},
						providerOptions: { "openai-codex": { omitItemId: true } },
					},
				],
			},
		]);

		expect(input).toEqual([
			{ type: "function_call", call_id: "plain_id", name: "first", arguments: "{}" },
			{ type: "function_call", call_id: "call_2", name: "second", arguments: "{}" },
		]);
	});

	it("keeps image tool results inside function_call_output for vision models", () => {
		const prompt: LanguageModelV3Prompt = [
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call_1|fc_1",
						toolName: "screenshot",
						output: {
							type: "content",
							value: [
								{ type: "text", text: "the page" },
								{ type: "file-data", data: "aGVsbG8=", mediaType: "image/png" },
							],
						},
					},
				],
			},
		];

		expect(convertToOpenAICodexPrompt(prompt, { supportsImages: true }).input[0]).toEqual({
			type: "function_call_output",
			call_id: "call_1",
			output: [
				{ type: "input_text", text: "the page" },
				{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "auto" },
			],
		});
		expect(convertToOpenAICodexPrompt(prompt, { supportsImages: false }).input[0]).toEqual({
			type: "function_call_output",
			call_id: "call_1",
			output: "the page",
		});
	});
});

// ── streaming ────────────────────────────────────────────────────────────────

describe("doStream", () => {
	it("emits the V3 stream part sequence for text responses", async () => {
		const { fetch } = createMockFetch(sseResponse(textEvents));
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY, fetch });
		const { stream, request, response } = await provider("gpt-5.4").doStream({ prompt: userPrompt });
		const parts = await readAllParts(stream);

		expect(request?.body).toMatchObject({ model: "gpt-5.4", stream: true });
		expect(response?.headers).toMatchObject({ "content-type": "text/event-stream" });

		expect(parts.map((part) => part.type)).toEqual([
			"stream-start",
			"response-metadata",
			"text-start",
			"text-delta",
			"text-delta",
			"text-end",
			"finish",
		]);

		const metadata = parts[1];
		expect(metadata).toMatchObject({ id: "resp_1", modelId: "gpt-5.4" });

		const deltas = parts.filter((part) => part.type === "text-delta");
		expect(deltas.map((part) => (part.type === "text-delta" ? part.delta : ""))).toEqual(["Hello", " world"]);
		expect(deltas.every((part) => part.type === "text-delta" && part.id === "msg_1")).toBe(true);
		expect(parts.find((part) => part.type === "text-end")).toMatchObject({
			providerMetadata: { "openai-codex": { messageId: "msg_1" } },
		});

		const finish = parts.at(-1);
		expect(finish).toMatchObject({
			type: "finish",
			finishReason: { unified: "stop", raw: "completed" },
			usage: {
				inputTokens: { total: 100, noCache: 60, cacheRead: 40, cacheWrite: 0 },
				outputTokens: { total: 20, text: 15, reasoning: 5 },
			},
		});
	});

	it("finishes and cancels the SSE body at the terminal response event", async () => {
		const encoder = new TextEncoder();
		let cancelled = false;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`,
						),
					);
				},
				cancel() {
					cancelled = true;
				},
			}),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
		const { fetch } = createMockFetch(response);
		const { stream } = await createOpenAICodex({ apiKey: TEST_API_KEY, fetch })("gpt-5.4").doStream({
			prompt: userPrompt,
		});
		const parts = await readAllParts(stream);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "stop" } });
		expect(cancelled).toBe(true);
	});

	it("streams reasoning summaries as reasoning parts", async () => {
		const events = [
			{ type: "response.created", response: { id: "resp_2", model: "gpt-5.4" } },
			{ type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } },
			{ type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "Thinking" },
			{ type: "response.reasoning_text.delta", item_id: "rs_1", delta: " harder" },
			{ type: "response.output_item.done", item: { type: "reasoning", id: "rs_1" } },
			{ type: "response.completed", response: { status: "completed" } },
		];
		const { fetch } = createMockFetch(sseResponse(events));
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY, fetch });
		const { stream } = await provider("gpt-5.4").doStream({ prompt: userPrompt });
		const parts = await readAllParts(stream);

		expect(parts.map((part) => part.type)).toEqual([
			"stream-start",
			"response-metadata",
			"reasoning-start",
			"reasoning-delta",
			"reasoning-delta",
			"reasoning-end",
			"finish",
		]);
		const reasoningEnd = parts.find((part) => part.type === "reasoning-end");
		expect(reasoningEnd).toMatchObject({
			providerMetadata: { "openai-codex": { reasoningItem: expect.stringContaining('"id":"rs_1"') } },
		});
	});

	it("streams tool calls with composite ids and a tool-calls finish reason", async () => {
		const events = [
			{ type: "response.created", response: { id: "resp_3", model: "gpt-5.4" } },
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "math_operation", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"a":' },
			{ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "15}" },
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_1",
					call_id: "call_1",
					name: "math_operation",
					arguments: '{"a":15}',
					namespace: "math",
				},
			},
			{
				type: "response.completed",
				response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5 } },
			},
		];
		const { fetch } = createMockFetch(sseResponse(events));
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY, fetch });
		const { stream } = await provider("gpt-5.4").doStream({ prompt: userPrompt });
		const parts = await readAllParts(stream);

		expect(parts.map((part) => part.type)).toEqual([
			"stream-start",
			"response-metadata",
			"tool-input-start",
			"tool-input-delta",
			"tool-input-delta",
			"tool-input-end",
			"tool-call",
			"finish",
		]);

		const toolCallId = joinToolCallId("call_1", "fc_1");
		const start = parts.find((part) => part.type === "tool-input-start");
		expect(start).toMatchObject({ id: toolCallId, toolName: "math_operation" });

		const toolCall = parts.find((part) => part.type === "tool-call");
		expect(toolCall).toMatchObject({
			toolCallId,
			toolName: "math_operation",
			input: '{"a":15}',
			providerMetadata: { "openai-codex": { namespace: "math" } },
		});

		const finish = parts.at(-1);
		expect(finish).toMatchObject({ type: "finish", finishReason: { unified: "tool-calls", raw: "completed" } });
	});

	it("streams native custom tool calls through the standard tool-call parts", async () => {
		const events = [
			{ type: "response.created", response: { id: "resp_custom", model: "gpt-5.6-luna" } },
			{
				type: "response.output_item.added",
				item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "sample", input: "" },
			},
			{ type: "response.custom_tool_call_input.delta", item_id: "ctc_1", delta: "ab" },
			{ type: "response.custom_tool_call_input.done", item_id: "ctc_1", input: "abc" },
			{
				type: "response.output_item.done",
				item: {
					type: "custom_tool_call",
					id: "ctc_1",
					call_id: "call_1",
					name: "sample",
					input: "abc",
					namespace: "grammar",
				},
			},
			{ type: "response.completed", response: { status: "completed" } },
		];
		const { fetch } = createMockFetch(sseResponse(events));
		const { stream } = await createOpenAICodex({ apiKey: TEST_API_KEY, fetch })("gpt-5.6-luna").doStream({
			prompt: userPrompt,
			tools: [
				{
					type: "function",
					name: "sample",
					description: "Generate a sample",
					inputSchema: {
						type: "object",
						properties: { payload: { type: "string" } },
						required: ["payload"],
					},
					providerOptions: {
						"openai-codex": {
							grammar: {
								type: "grammar",
								format: "lark",
								definition: "start: /[a-z]+/",
								inputProperty: "payload",
							},
						},
					},
				},
			],
		});
		const parts = await readAllParts(stream);

		expect(parts.map((part) => part.type)).toEqual([
			"stream-start",
			"response-metadata",
			"tool-input-start",
			"tool-input-delta",
			"tool-input-delta",
			"tool-input-end",
			"tool-call",
			"finish",
		]);
		const deltas = parts
			.filter((part) => part.type === "tool-input-delta")
			.map((part) => (part.type === "tool-input-delta" ? part.delta : ""));
		expect(deltas.join("")).toBe('{"payload":"abc"}');
		expect(parts.find((part) => part.type === "tool-call")).toMatchObject({
			toolCallId: "call_1|ctc_1",
			toolName: "sample",
			input: '{"payload":"abc"}',
			providerMetadata: { "openai-codex": { namespace: "grammar" } },
		});
		expect(parts.at(-1)).toMatchObject({
			type: "finish",
			finishReason: { unified: "tool-calls", raw: "completed" },
		});
	});

	it("maps max-output incomplete responses to a length finish reason", async () => {
		const events = [
			{ type: "response.created", response: { id: "resp_4", model: "gpt-5.4" } },
			{
				type: "response.incomplete",
				response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
			},
		];
		const { fetch } = createMockFetch(sseResponse(events));
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY, fetch });
		const { stream } = await provider("gpt-5.4").doStream({ prompt: userPrompt });
		const parts = await readAllParts(stream);

		expect(parts.at(-1)).toMatchObject({
			type: "finish",
			finishReason: { unified: "length", raw: "incomplete.max_output_tokens" },
		});
	});

	it("maps incomplete responses without a max-output reason to an error", async () => {
		const events = [{ type: "response.incomplete", response: { status: "incomplete" } }];
		const { fetch } = createMockFetch(sseResponse(events));
		const { stream } = await createOpenAICodex({ apiKey: TEST_API_KEY, fetch })("gpt-5.4").doStream({
			prompt: userPrompt,
		});
		const parts = await readAllParts(stream);

		expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "error", raw: "incomplete" } });
	});

	it("surfaces stream error events as error parts", async () => {
		const events = [
			{ type: "response.created", response: { id: "resp_5", model: "gpt-5.4" } },
			{ type: "error", code: "rate_limit", message: "slow down" },
		];
		const { fetch } = createMockFetch(sseResponse(events));
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY, fetch });
		const { stream } = await provider("gpt-5.4").doStream({ prompt: userPrompt });
		const parts = await readAllParts(stream);

		const error = parts.find((part) => part.type === "error");
		expect(error?.type === "error" && error.error instanceof Error && error.error.message).toContain("slow down");
	});

	it("surfaces response.failed events as error parts", async () => {
		const events = [
			{ type: "response.created", response: { id: "resp_6", model: "gpt-5.4" } },
			{ type: "response.failed", response: { error: { code: "server_error", message: "backend exploded" } } },
		];
		const { fetch } = createMockFetch(sseResponse(events));
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY, fetch });
		const { stream } = await provider("gpt-5.4").doStream({ prompt: userPrompt });
		const parts = await readAllParts(stream);

		const error = parts.find((part) => part.type === "error");
		expect(error?.type === "error" && error.error instanceof Error && error.error.message).toContain(
			"backend exploded",
		);
	});

	it("emits raw chunks when includeRawChunks is set", async () => {
		const { fetch } = createMockFetch(sseResponse(textEvents));
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY, fetch });
		const { stream } = await provider("gpt-5.4").doStream({ prompt: userPrompt, includeRawChunks: true });
		const parts = await readAllParts(stream);

		expect(parts.filter((part) => part.type === "raw")).toHaveLength(textEvents.length);
	});

	it("throws APICallError with a friendly message on usage limits", async () => {
		const errorBody = JSON.stringify({
			error: {
				code: "usage_limit_reached",
				message: "usage limit",
				plan_type: "PLUS",
				resets_at: Math.round(Date.now() / 1000) + 30 * 60,
			},
		});
		const { fetch } = createMockFetch(new Response(errorBody, { status: 429, statusText: "Too Many Requests" }));
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY, fetch });

		const error = await provider("gpt-5.4")
			.doStream({ prompt: userPrompt })
			.then(
				() => undefined,
				(thrown: unknown) => thrown,
			);

		expect(APICallError.isInstance(error)).toBe(true);
		if (APICallError.isInstance(error)) {
			expect(error.statusCode).toBe(429);
			expect(error.message).toContain("ChatGPT usage limit");
			expect(error.message).toContain("plus plan");
		}
	});

	it("throws APICallError with the backend message on other failures", async () => {
		const errorBody = JSON.stringify({ error: { code: "server_error", message: "something broke" } });
		const { fetch } = createMockFetch(new Response(errorBody, { status: 500, statusText: "Server Error" }));
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY, fetch });

		const error = await provider("gpt-5.4")
			.doStream({ prompt: userPrompt })
			.then(
				() => undefined,
				(thrown: unknown) => thrown,
			);

		expect(APICallError.isInstance(error)).toBe(true);
		if (APICallError.isInstance(error)) {
			expect(error.statusCode).toBe(500);
			expect(error.message).toContain("something broke");
			expect(error.isRetryable).toBe(true);
		}
	});
});

// ── doGenerate ───────────────────────────────────────────────────────────────

describe("doGenerate", () => {
	it("aggregates the stream into ordered content", async () => {
		const events = [
			{ type: "response.created", response: { id: "resp_7", model: "gpt-5.4" } },
			{ type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } },
			{ type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "Plan it" },
			{ type: "response.output_item.done", item: { type: "reasoning", id: "rs_1" } },
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "math_operation", arguments: "" },
			},
			{
				type: "response.output_item.done",
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "math_operation", arguments: "{}" },
			},
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Done" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Done", annotations: [] }],
				},
			},
			{
				type: "response.completed",
				response: { status: "completed", usage: { input_tokens: 11, output_tokens: 7 } },
			},
		];
		const { fetch } = createMockFetch(sseResponse(events));
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY, fetch });
		const result = await provider("gpt-5.4").doGenerate({ prompt: userPrompt });

		expect(result.content).toEqual([
			{
				type: "reasoning",
				text: "Plan it",
				providerMetadata: { "openai-codex": { reasoningItem: '{"type":"reasoning","id":"rs_1"}' } },
			},
			expect.objectContaining({ type: "tool-call", toolCallId: joinToolCallId("call_1", "fc_1") }),
			{
				type: "text",
				text: "Done",
				providerMetadata: { "openai-codex": { messageId: "msg_1" } },
			},
		]);
		expect(result.finishReason).toEqual({ unified: "tool-calls", raw: "completed" });
		expect(result.usage.inputTokens.total).toBe(11);
		expect(result.usage.outputTokens.total).toBe(7);
		expect(result.response?.id).toBe("resp_7");
		expect(result.response?.modelId).toBe("gpt-5.4");
		expect(result.warnings).toEqual([]);
	});

	it("propagates stream errors as rejections", async () => {
		const events = [
			{ type: "response.created", response: { id: "resp_8", model: "gpt-5.4" } },
			{ type: "error", code: "bad", message: "boom" },
		];
		const { fetch } = createMockFetch(sseResponse(events));
		const provider = createOpenAICodex({ apiKey: TEST_API_KEY, fetch });

		await expect(provider("gpt-5.4").doGenerate({ prompt: userPrompt })).rejects.toThrow(/boom/);
	});
});

// ── registry integration ─────────────────────────────────────────────────────

describe("registry integration", () => {
	it("registers @codeworksh/ai-sdk-openai-codex as a known AI SDK package", () => {
		expect(isAISDKPackage("@codeworksh/ai-sdk-openai-codex")).toBe(true);
		expect(AI_SDK_PACKAGE_TO_PROTOCOL["@codeworksh/ai-sdk-openai-codex"]).toBe("openai-codex");
		expect(protocolForPackage("@codeworksh/ai-sdk-openai-codex")).toBe("openai-codex");
	});

	it("loads the createOpenAICodex factory through the provider loader", async () => {
		const factory = await loadProviderFactory("@codeworksh/ai-sdk-openai-codex");
		const provider = factory({ apiKey: TEST_API_KEY }) as ReturnType<typeof createOpenAICodex>;
		expect(provider.responses("gpt-5.4")).toBeInstanceOf(OpenAICodexLanguageModel);
	});
});

// ── oauth key helper ─────────────────────────────────────────────────────────

describe("getOpenAICodexApiKey", () => {
	function makeCredentials(): OpenAICodexOAuthCredentials {
		return {
			access: TEST_API_KEY,
			refresh: "refresh-token",
			expires: Date.now() + 60 * 60 * 1000,
			accountId: TEST_ACCOUNT_ID,
		};
	}

	it("prefers the OPENAI_CODEX_API_KEY environment variable", async () => {
		process.env.OPENAI_CODEX_API_KEY = "env-key";
		await expect(getOpenAICodexApiKey()).resolves.toBe("env-key");
	});

	it("falls back to stored OAuth credentials", async () => {
		const credentials = makeCredentials();
		const storage = {
			get: async () => credentials,
			set: async () => {},
			clear: async () => {},
		};
		await expect(getOpenAICodexApiKey({ storage })).resolves.toBe(TEST_API_KEY);
	});

	it("resolves undefined when no key source is available", async () => {
		const storage = {
			get: async () => undefined,
			set: async () => {},
			clear: async () => {},
		};
		await expect(getOpenAICodexApiKey({ storage })).resolves.toBeUndefined();
	});
});
