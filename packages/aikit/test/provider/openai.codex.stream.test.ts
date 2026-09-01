/** Streaming, SSE decoding, usage, and error mapping for the OpenAI Codex provider. */
import { APICallError } from "@ai-sdk/provider";
import { describe, expect, it } from "vite-plus/test";
import {
	convertOpenAICodexUsage,
	createOpenAICodex,
	joinToolCallId,
	mapOpenAICodexFinishReason,
} from "../../src/providers/openai-codex/index.ts";
import {
	createOpenAICodexMockFetch,
	OPENAI_CODEX_TEST_API_KEY,
	openAICodexSSEResponse,
	openAICodexTextEvents,
	openAICodexUserPrompt,
	readOpenAICodexStream,
} from "../utils/openai-codex.ts";

describe("usage and finish-reason mapping", () => {
	it("accounts separately for uncached, cache-read, cache-write, text, and reasoning tokens", () => {
		const usage = {
			input_tokens: 100,
			output_tokens: 30,
			input_tokens_details: { cached_tokens: 25, cache_write_tokens: 10 },
			output_tokens_details: { reasoning_tokens: 7 },
		};
		expect(convertOpenAICodexUsage(usage)).toEqual({
			inputTokens: { total: 100, noCache: 65, cacheRead: 25, cacheWrite: 10 },
			outputTokens: { total: 30, text: 23, reasoning: 7 },
			raw: usage,
		});
	});

	it("maps every terminal status without relying on stream integration", () => {
		expect(mapOpenAICodexFinishReason("completed", false)).toEqual({ unified: "stop", raw: "completed" });
		expect(mapOpenAICodexFinishReason("completed", true)).toEqual({
			unified: "tool-calls",
			raw: "completed",
		});
		expect(mapOpenAICodexFinishReason("incomplete", false, "max_output_tokens")).toEqual({
			unified: "length",
			raw: "incomplete.max_output_tokens",
		});
		expect(mapOpenAICodexFinishReason("failed", false)).toEqual({ unified: "error", raw: "failed" });
		expect(mapOpenAICodexFinishReason("cancelled", false)).toEqual({ unified: "error", raw: "cancelled" });
		expect(mapOpenAICodexFinishReason(undefined, false)).toEqual({ unified: "other", raw: undefined });
	});
});

// ── streaming ────────────────────────────────────────────────────────────────

describe("doStream", () => {
	it("emits the V3 stream part sequence for text responses", async () => {
		const { fetch } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		const provider = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch });
		const { stream, request, response } = await provider("gpt-5.4").doStream({ prompt: openAICodexUserPrompt });
		const parts = await readOpenAICodexStream(stream);

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
		const { fetch } = createOpenAICodexMockFetch(response);
		const { stream } = await createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch })("gpt-5.4").doStream({
			prompt: openAICodexUserPrompt,
		});
		const parts = await readOpenAICodexStream(stream);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "stop" } });
		expect(cancelled).toBe(true);
	});

	it("decodes CRLF, comments, and multiline SSE data", async () => {
		const response = new Response(
			[
				": keep-alive",
				"event: response",
				"id: event-1",
				'data: {"type":"response.created",',
				'data: "response":{"id":"resp_crlf","model":"gpt-5.4"}}',
				"",
				'data: {"type":"response.completed","response":{"status":"completed"}}',
				"",
				"",
			].join("\r\n"),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
		const { fetch } = createOpenAICodexMockFetch(response);
		const { stream } = await createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch })("gpt-5.4").doStream({
			prompt: openAICodexUserPrompt,
		});
		const parts = await readOpenAICodexStream(stream);

		expect(parts.map((part) => part.type)).toEqual(["stream-start", "response-metadata", "finish"]);
		expect(parts[1]).toMatchObject({ type: "response-metadata", id: "resp_crlf", modelId: "gpt-5.4" });
	});

	it("reports a retryable transport error when SSE closes before a terminal event", async () => {
		const events = [{ type: "response.created", response: { id: "resp_truncated", model: "gpt-5.4" } }];
		const { fetch } = createOpenAICodexMockFetch(openAICodexSSEResponse(events));
		const { stream } = await createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch })("gpt-5.4").doStream({
			prompt: openAICodexUserPrompt,
		});
		const parts = await readOpenAICodexStream(stream);
		const error = parts.at(-1);

		expect(parts.some((part) => part.type === "finish")).toBe(false);
		expect(error?.type).toBe("error");
		if (error?.type === "error") {
			expect(APICallError.isInstance(error.error)).toBe(true);
			expect(error.error).toMatchObject({
				message: expect.stringContaining("closed before response.completed"),
				isRetryable: true,
			});
		}
	});

	it("does not accept the WebSocket-only response.done event on HTTP", async () => {
		const events = [{ type: "response.done", response: { status: "completed" } }];
		const { fetch } = createOpenAICodexMockFetch(openAICodexSSEResponse(events));
		const { stream } = await createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch })("gpt-5.4").doStream({
			prompt: openAICodexUserPrompt,
		});
		const parts = await readOpenAICodexStream(stream);

		expect(parts.some((part) => part.type === "finish")).toBe(false);
		expect(parts.at(-1)).toMatchObject({ type: "error" });
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
		const { fetch } = createOpenAICodexMockFetch(openAICodexSSEResponse(events));
		const provider = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch });
		const { stream } = await provider("gpt-5.4").doStream({ prompt: openAICodexUserPrompt });
		const parts = await readOpenAICodexStream(stream);

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
		const { fetch } = createOpenAICodexMockFetch(openAICodexSSEResponse(events));
		const provider = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch });
		const { stream } = await provider("gpt-5.4").doStream({ prompt: openAICodexUserPrompt });
		const parts = await readOpenAICodexStream(stream);

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
		const { fetch } = createOpenAICodexMockFetch(openAICodexSSEResponse(events));
		const { stream } = await createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch })("gpt-5.6-luna").doStream(
			{
				prompt: openAICodexUserPrompt,
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
			},
		);
		const parts = await readOpenAICodexStream(stream);

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
		const { fetch } = createOpenAICodexMockFetch(openAICodexSSEResponse(events));
		const provider = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch });
		const { stream } = await provider("gpt-5.4").doStream({ prompt: openAICodexUserPrompt });
		const parts = await readOpenAICodexStream(stream);

		expect(parts.at(-1)).toMatchObject({
			type: "finish",
			finishReason: { unified: "length", raw: "incomplete.max_output_tokens" },
		});
	});

	it("maps incomplete responses without a max-output reason to an error", async () => {
		const events = [{ type: "response.incomplete", response: { status: "incomplete" } }];
		const { fetch } = createOpenAICodexMockFetch(openAICodexSSEResponse(events));
		const { stream } = await createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch })("gpt-5.4").doStream({
			prompt: openAICodexUserPrompt,
		});
		const parts = await readOpenAICodexStream(stream);

		expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "error", raw: "incomplete" } });
	});

	it("surfaces stream error events as error parts", async () => {
		const events = [
			{ type: "response.created", response: { id: "resp_5", model: "gpt-5.4" } },
			{ type: "error", code: "rate_limit_exceeded", message: "Please try again in 250ms." },
		];
		const { fetch } = createOpenAICodexMockFetch(openAICodexSSEResponse(events));
		const provider = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch });
		const { stream } = await provider("gpt-5.4").doStream({ prompt: openAICodexUserPrompt });
		const parts = await readOpenAICodexStream(stream);

		const error = parts.find((part) => part.type === "error");
		expect(error?.type === "error" && error.error instanceof Error && error.error.message).toContain("try again");
		if (error?.type === "error" && APICallError.isInstance(error.error)) {
			expect(error.error).toMatchObject({ statusCode: 429, isRetryable: true });
			expect(error.error.responseHeaders).toMatchObject({ "retry-after": "0.25" });
			expect(error.error.data).toEqual({
				error: {
					code: "rate_limit_exceeded",
					type: "error",
					message: "Please try again in 250ms.",
				},
			});
		}
	});

	it("surfaces response.failed events as error parts", async () => {
		const events = [
			{ type: "response.created", response: { id: "resp_6", model: "gpt-5.4" } },
			{ type: "response.failed", response: { error: { code: "server_error", message: "backend exploded" } } },
		];
		const { fetch } = createOpenAICodexMockFetch(openAICodexSSEResponse(events));
		const provider = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch });
		const { stream } = await provider("gpt-5.4").doStream({ prompt: openAICodexUserPrompt });
		const parts = await readOpenAICodexStream(stream);

		const error = parts.find((part) => part.type === "error");
		expect(error?.type === "error" && error.error instanceof Error && error.error.message).toContain(
			"backend exploded",
		);
	});

	it("emits raw chunks when includeRawChunks is set", async () => {
		const { fetch } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		const provider = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch });
		const { stream } = await provider("gpt-5.4").doStream({ prompt: openAICodexUserPrompt, includeRawChunks: true });
		const parts = await readOpenAICodexStream(stream);

		expect(parts.filter((part) => part.type === "raw")).toHaveLength(openAICodexTextEvents.length);
	});

	it("throws APICallError with a friendly message on usage limits", async () => {
		const errorBody = JSON.stringify({
			error: {
				code: "usage_limit_reached",
				type: "GoUsageLimitError",
				message: "usage limit",
				plan_type: "PLUS",
				resets_at: Math.round(Date.now() / 1000) + 30 * 60,
			},
		});
		const { fetch } = createOpenAICodexMockFetch(
			new Response(errorBody, { status: 429, statusText: "Too Many Requests" }),
		);
		const provider = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch });

		const error = await provider("gpt-5.4")
			.doStream({ prompt: openAICodexUserPrompt })
			.then(
				() => undefined,
				(thrown: unknown) => thrown,
			);

		expect(APICallError.isInstance(error)).toBe(true);
		if (APICallError.isInstance(error)) {
			expect(error.statusCode).toBe(429);
			expect(error.message).toContain("ChatGPT usage limit");
			expect(error.message).toContain("plus plan");
			expect(error.isRetryable).toBe(false);
			expect(error.data).toMatchObject({ error: { code: "usage_limit_reached" } });
		}
	});

	it("keeps transient HTTP rate limits retryable and preserves backend metadata", async () => {
		const errorBody = JSON.stringify({
			error: {
				code: "rate_limit_exceeded",
				message: "Rate limit reached. Please try again in 1.5s.",
			},
		});
		const { fetch } = createOpenAICodexMockFetch(
			new Response(errorBody, {
				status: 429,
				statusText: "Too Many Requests",
				headers: { "x-oai-request-id": "req_codex" },
			}),
		);

		const error = await createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch })("gpt-5.4")
			.doStream({ prompt: openAICodexUserPrompt })
			.then(
				() => undefined,
				(thrown: unknown) => thrown,
			);

		expect(APICallError.isInstance(error)).toBe(true);
		if (APICallError.isInstance(error)) {
			expect(error.message).toContain("Rate limit reached");
			expect(error.message).not.toContain("ChatGPT usage limit");
			expect(error.isRetryable).toBe(true);
			expect(error.data).toMatchObject({ error: { code: "rate_limit_exceeded" } });
			expect(error.responseHeaders).toMatchObject({ "x-oai-request-id": "req_codex" });
		}
	});

	it("treats usage-not-included errors as terminal", async () => {
		const errorBody = JSON.stringify({
			error: { code: "usage_not_included", message: "Codex is not included in this plan." },
		});
		const { fetch } = createOpenAICodexMockFetch(new Response(errorBody, { status: 429 }));

		const error = await createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch })("gpt-5.4")
			.doStream({ prompt: openAICodexUserPrompt })
			.then(
				() => undefined,
				(thrown: unknown) => thrown,
			);

		expect(error).toMatchObject({
			statusCode: 429,
			message: "Codex is not included in this plan.",
			isRetryable: false,
		});
	});

	it("throws APICallError with the backend message on other failures", async () => {
		const errorBody = JSON.stringify({ error: { code: "server_error", message: "something broke" } });
		const { fetch } = createOpenAICodexMockFetch(
			new Response(errorBody, { status: 500, statusText: "Server Error" }),
		);
		const provider = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch });

		const error = await provider("gpt-5.4")
			.doStream({ prompt: openAICodexUserPrompt })
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
		const { fetch } = createOpenAICodexMockFetch(openAICodexSSEResponse(events));
		const provider = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch });
		const result = await provider("gpt-5.4").doGenerate({ prompt: openAICodexUserPrompt });

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
		const { fetch } = createOpenAICodexMockFetch(openAICodexSSEResponse(events));
		const provider = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch });

		await expect(provider("gpt-5.4").doGenerate({ prompt: openAICodexUserPrompt })).rejects.toThrow(/boom/);
	});
});
