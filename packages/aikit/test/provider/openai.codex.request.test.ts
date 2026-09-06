import { openAICodexBuiltInModels } from "../../src/cli/modelgen.ts";
import { stream } from "../../src/stream.ts";
import { makeUserMessage } from "../utils/fixtures.ts";
/** Request shaping for the OpenAI Codex Responses endpoint. */
import { describe, expect, it } from "vite-plus/test";
import { createOpenAICodex, resolveOpenAICodexUrl } from "../../src/providers/openai-codex/index.ts";
import {
	createOpenAICodexMockFetch,
	OPENAI_CODEX_TEST_ACCOUNT_ID,
	OPENAI_CODEX_TEST_API_KEY,
	openAICodexDeferredTools,
	openAICodexDeferredToolsPrompt,
	openAICodexSSEResponse,
	openAICodexTextEvents,
	openAICodexUserPrompt,
	readOpenAICodexStream,
} from "../utils/openai-codex.ts";

describe("request", () => {
	it.each(["gpt-5.3-codex-spark", "gpt-5.4"])(
		"derives image support from %s metadata despite a partial factory override",
		async (id) => {
			const metadata = openAICodexBuiltInModels()[id]!;
			const model = { ...metadata, id: "custom-model", api: { ...metadata.api, id: "custom-model" } };
			const { fetch, body } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
			const user = makeUserMessage("Describe the image");
			user.parts.push({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
			const result = await stream.complete(
				model,
				{ messages: [user] },
				{
					apiKey: OPENAI_CODEX_TEST_API_KEY,
					factoryOptions: { fetch, compat: { supportsToolSearch: false } },
				},
			);
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(JSON.stringify(body().input).includes("input_image")).toBe(metadata.input.includes("image"));
		},
	);
	it("posts to the codex responses endpoint with Codex headers", async () => {
		const { fetch, calls } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		const provider = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, sessionId: "session-1", fetch });
		await provider("gpt-5.4").doStream({ prompt: openAICodexUserPrompt });

		const call = calls[0]!;
		expect(call.url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(call.init.method).toBe("POST");
		expect(call.init.headers).toMatchObject({
			Authorization: `Bearer ${OPENAI_CODEX_TEST_API_KEY}`,
			"chatgpt-account-id": OPENAI_CODEX_TEST_ACCOUNT_ID,
			"OpenAI-Beta": "responses=experimental",
			originator: "codework",
			accept: "text/event-stream",
			"content-type": "application/json",
			"session-id": "session-1",
			"x-client-request-id": "session-1",
		});
	});

	it("merges provider and per-call headers", async () => {
		const { fetch, calls } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		const provider = createOpenAICodex({
			apiKey: OPENAI_CODEX_TEST_API_KEY,
			headers: { "x-provider": "a" },
			fetch,
		});
		await provider("gpt-5.4").doStream({ prompt: openAICodexUserPrompt, headers: { "x-call": "b" } });

		expect(calls[0]?.init.headers).toMatchObject({ "x-provider": "a", "x-call": "b" });
	});

	it("builds the Codex request body with defaults", async () => {
		const { fetch, body } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		const provider = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch });
		await provider("gpt-5.4").doStream({ prompt: openAICodexUserPrompt, temperature: 0.2 });

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
		const { fetch, body } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		const provider = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch });
		const { stream } = await provider("gpt-5.4").doStream({
			prompt: openAICodexUserPrompt,
			maxOutputTokens: 4096,
		});
		const parts = await readOpenAICodexStream(stream);

		expect(body().max_output_tokens).toBeUndefined();
		const start = parts.find((part) => part.type === "stream-start");
		const features =
			start?.type === "stream-start"
				? start.warnings.map((warning) => (warning.type === "unsupported" ? warning.feature : warning.type))
				: [];
		expect(features).toContain("maxOutputTokens");
	});

	it("maps tools and tool choice", async () => {
		const { fetch, body } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		const provider = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch });
		await provider("gpt-5.4").doStream({
			prompt: openAICodexUserPrompt,
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
		const { fetch, body } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		await createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch })("gpt-5.6-luna").doStream({
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
		const { fetch, body } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		await createOpenAICodex({
			apiKey: OPENAI_CODEX_TEST_API_KEY,
			fetch,
			compat: { ...openAICodexBuiltInModels()["gpt-5.6-luna"]!.compat },
		})("gpt-5.6-luna").doStream({
			prompt: openAICodexDeferredToolsPrompt,
			tools: [
				openAICodexDeferredTools[0]!,
				{
					...openAICodexDeferredTools[1]!,
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

	it("uses generated deferred-tool capabilities even with an unknown model ID", async () => {
		const { fetch, body } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		await createOpenAICodex({
			apiKey: OPENAI_CODEX_TEST_API_KEY,
			fetch,
			compat: { ...openAICodexBuiltInModels()["gpt-5.6-luna"]!.compat },
		})("custom-codex").doStream({
			prompt: openAICodexDeferredToolsPrompt,
			tools: openAICodexDeferredTools,
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
		const { fetch, body } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		await createOpenAICodex({
			apiKey: OPENAI_CODEX_TEST_API_KEY,
			fetch,
			compat: { ...openAICodexBuiltInModels()["gpt-5.4"]!.compat },
		})("gpt-5.4").doStream({
			prompt: openAICodexDeferredToolsPrompt,
			tools: openAICodexDeferredTools,
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
		const { fetch, body } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		await createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch })("gpt-5.3-codex-spark").doStream({
			prompt: openAICodexDeferredToolsPrompt,
			tools: openAICodexDeferredTools,
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
		const { fetch, body } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		await createOpenAICodex({
			apiKey: OPENAI_CODEX_TEST_API_KEY,
			fetch,
			compat: { supportsToolSearch: false, supportsAdditionalTools: false },
		})("gpt-5.6-luna").doStream({ prompt: openAICodexDeferredToolsPrompt, tools: openAICodexDeferredTools });

		expect(body().tools).toMatchObject([{ name: "base_tool" }, { name: "late_tool" }]);
	});

	it("applies openai-codex provider options", async () => {
		const { fetch, body } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		const provider = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch });
		await provider("gpt-5.4").doStream({
			prompt: openAICodexUserPrompt,
			providerOptions: {
				"openai-codex": {
					reasoningEffort: "high",
					reasoningSummary: "detailed",
					textVerbosity: "medium",
					serviceTier: "flex",
				},
			},
		});

		expect(body()).toMatchObject({
			reasoning: { effort: "high", summary: "detailed" },
			text: { verbosity: "medium" },
			service_tier: "flex",
		});
	});

	it("forwards max reasoning effort for GPT-5.6 Codex models", async () => {
		const { fetch, body } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		const provider = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch });
		await provider("gpt-5.6-sol").doStream({
			prompt: openAICodexUserPrompt,
			providerOptions: { "openai-codex": { reasoningEffort: "max" } },
		});

		expect(body().reasoning).toEqual({ effort: "max", summary: "auto" });
	});

	it("defaults the prompt cache key to the provider sessionId", async () => {
		const { fetch, body } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		const provider = createOpenAICodex({
			apiKey: OPENAI_CODEX_TEST_API_KEY,
			sessionId: "session-9",
			fetch,
		});
		await provider("gpt-5.4").doStream({ prompt: openAICodexUserPrompt });

		expect(body().prompt_cache_key).toBe("session-9");
	});

	it("clamps Codex cache-affinity values to 64 Unicode characters", async () => {
		const sessionId = `${"🙂".repeat(64)}overflow`;
		const { fetch, body, calls } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		const provider = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, sessionId, fetch });
		await provider("gpt-5.4").doStream({ prompt: openAICodexUserPrompt });

		const expected = "🙂".repeat(64);
		expect(body().prompt_cache_key).toBe(expected);
		expect(calls[0]?.init.headers["session-id"]).toBe(expected);
		expect(calls[0]?.init.headers["x-client-request-id"]).toBe(expected);
	});

	it("zstd-compresses Codex SSE request bodies when Node supports it", async () => {
		const { fetch, body, calls } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		await createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch })("gpt-5.4").doStream({
			prompt: openAICodexUserPrompt,
		});

		expect(calls[0]?.init.headers["content-encoding"]).toBe("zstd");
		expect(body()).toMatchObject({ model: "gpt-5.4", stream: true });
	});

	it("maps schema-constrained JSON output to the native Codex text format", async () => {
		const { fetch, body } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		const { stream } = await createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch })("gpt-5.4").doStream({
			prompt: openAICodexUserPrompt,
			responseFormat: {
				type: "json",
				name: "answer",
				schema: {
					type: "object",
					properties: { value: { type: "string" } },
					required: ["value"],
					additionalProperties: false,
				},
			},
		});
		const parts = await readOpenAICodexStream(stream);

		expect(body().text).toEqual({
			verbosity: "low",
			format: {
				type: "json_schema",
				strict: true,
				name: "answer",
				schema: {
					type: "object",
					properties: { value: { type: "string" } },
					required: ["value"],
					additionalProperties: false,
				},
			},
		});
		const start = parts.find((part) => part.type === "stream-start");
		expect(start?.type === "stream-start" ? start.warnings : []).not.toContainEqual(
			expect.objectContaining({ feature: "responseFormat" }),
		);
	});

	it("warns on unsupported call options instead of sending them", async () => {
		const { fetch, body } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		const provider = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch });
		const { stream } = await provider("gpt-5.4").doStream({
			prompt: openAICodexUserPrompt,
			topP: 0.5,
			topK: 10,
			presencePenalty: 0.1,
			frequencyPenalty: 0.1,
			seed: 42,
			stopSequences: ["stop"],
			responseFormat: { type: "json" },
		});

		const parts = await readOpenAICodexStream(stream);
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
