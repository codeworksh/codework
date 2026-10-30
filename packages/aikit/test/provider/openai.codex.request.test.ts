import Type from "typebox";
import { stream } from "../../src/stream.ts";
import * as Message from "../../src/message/message.ts";
import { makeAssistantMessage, makeCompletedToolCall, makeUserMessage } from "../utils/fixtures.ts";
/** Request shaping for the OpenAI Codex Responses endpoint. */
import { describe, expect, it } from "vite-plus/test";
import { createOpenAICodex, openAICodexTools, resolveOpenAICodexUrl } from "../../src/providers/openai-codex/index.ts";
import {
	createOpenAICodexMockFetch,
	OPENAI_CODEX_TEST_ACCOUNT_ID,
	OPENAI_CODEX_TEST_API_KEY,
	openAICodexLoadableTools,
	openAICodexToolChangePrompt,
	openAICodexToolRemovalPrompt,
	openAICodexModels,
	openAICodexSSEResponse,
	openAICodexTextEvents,
	openAICodexUserPrompt,
	readOpenAICodexStream,
} from "../utils/openai-codex.ts";

describe("request", () => {
	it.each(["gpt-5.3-codex-spark", "gpt-6-luna"])(
		"derives image support from %s metadata despite a partial factory override",
		async (id) => {
			const metadata = openAICodexModels()[id]!;
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

	it("declares every tool in additional_tools and keeps grammar tools native", async () => {
		const { fetch, body } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		const grammarTool = {
			...openAICodexLoadableTools[1]!,
			providerOptions: {
				"openai-codex": {
					grammar: { type: "grammar", format: "regex", definition: "[a-z]+", inputProperty: "value" },
				},
			},
		};
		await createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch })("gpt-5.6-luna").doStream({
			prompt: openAICodexToolChangePrompt("changes", grammarTool),
			tools: [openAICodexLoadableTools[0]!, grammarTool],
		});

		const payload = body();
		expect(payload.tools).toBeUndefined();
		const input = payload.input as Array<Record<string, unknown>>;
		const additionalTools = input.filter((item) => item.type === "additional_tools");
		expect(additionalTools.map((item) => item.tools)).toEqual([
			[expect.objectContaining({ type: "function", name: "base_tool" })],
			[
				expect.objectContaining({
					type: "custom",
					name: "late_tool",
					format: { type: "grammar", syntax: "regex", definition: "[a-z]+" },
				}),
			],
		]);
		// The head declaration leads the input; the later one follows the tool result.
		expect(input[0]).toMatchObject({ type: "additional_tools" });
		const late = input.indexOf(additionalTools[1]!);
		expect(input[late - 2]).toMatchObject({ type: "function_call_output" });
		expect(input[late - 1]).toMatchObject({
			role: "developer",
			content: expect.stringContaining("incremental tools update"),
		});
	});

	it("announces removals as text and lists them while still unavailable", async () => {
		const { fetch, body } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		await createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch })("gpt-5.6-luna").doStream({
			prompt: openAICodexToolRemovalPrompt,
			tools: [openAICodexLoadableTools[1]!],
		});

		const input = body().input as Array<Record<string, unknown>>;
		const developer = input.filter((item) => item.role === "developer" && typeof item.content === "string");
		expect(developer.map((item) => item.content)).toEqual([
			expect.stringContaining("no longer available. Do not call them:\n- base_tool"),
			expect.stringContaining("Still unavailable: base_tool."),
		]);
	});

	it("declares later tools as a synthetic tool search in additions mode", async () => {
		const { fetch, body } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		await createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch })("gpt-6-luna").doStream({
			prompt: openAICodexToolChangePrompt("additions"),
			tools: openAICodexLoadableTools,
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

	it("keeps all tools top-level when the prompt declares no tool changes", async () => {
		const { fetch, body } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		await createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY, fetch })("gpt-5.3-codex-spark").doStream({
			prompt: openAICodexUserPrompt,
			tools: openAICodexLoadableTools,
		});

		const payload = body();
		expect(payload.tools).toMatchObject([{ name: "base_tool" }, { name: "late_tool" }]);
		expect(
			(payload.input as Array<{ type?: string }>).some(
				(item) => item.type === "additional_tools" || item.type === "tool_search_output",
			),
		).toBe(false);
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

describe("transport failures", () => {
	const model = openAICodexModels()["gpt-6-luna"]!;

	it("retries a fetch that never answers, then fails with the request it sent", async () => {
		let calls = 0;
		const fetch: typeof globalThis.fetch = async () => {
			calls++;
			throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
		};
		const result = await stream.complete(
			model,
			{ messages: [makeUserMessage("hello")] },
			{ apiKey: OPENAI_CODEX_TEST_API_KEY, reasoning: "high", maxRetries: 1, factoryOptions: { fetch } },
		);
		expect(calls).toBe(2);
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "cannot connect to API: connect ECONNREFUSED",
			failure: { _tag: "Transport", retryable: true },
			thinkingLevel: "high",
			providerThinkingLevel: "high",
		});
	});

	it("does not retry an aborted fetch", async () => {
		const controller = new AbortController();
		let calls = 0;
		const fetch: typeof globalThis.fetch = async () => {
			calls++;
			controller.abort();
			throw new DOMException("The operation was aborted.", "AbortError");
		};
		const result = await stream.complete(
			model,
			{ messages: [makeUserMessage("hello")] },
			{
				apiKey: OPENAI_CODEX_TEST_API_KEY,
				reasoning: "high",
				maxRetries: 2,
				signal: controller.signal,
				factoryOptions: { fetch },
			},
		);
		expect(calls).toBe(1);
		expect(result.stopReason).toBe("aborted");
	});

	it("replays a grammar tool's calls after the tool is removed", async () => {
		const model = openAICodexModels()["gpt-6-luna"]!;
		const edit = openAICodexTools.custom({
			name: "edit",
			description: "Edit text",
			parameters: Type.Object({ patch: Type.String() }),
			format: { type: "grammar", syntax: "regex", definition: "[a-z]+" },
		});
		const call = makeCompletedToolCall("call_1|ctc_1", "edit", [{ type: "text", text: "done" }], { patch: "abc" });
		const { fetch, body } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		const result = await stream.complete(
			model,
			{
				tools: [edit],
				messages: [
					makeUserMessage("edit it"),
					makeAssistantMessage(model, { stopReason: "toolUse", parts: [call] }),
					Message.createSystemMessage({ toolsRemoved: [{ name: "edit" }] }),
				],
			},
			{ apiKey: OPENAI_CODEX_TEST_API_KEY, factoryOptions: { fetch } },
		);

		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(body().input).toContainEqual(
			expect.objectContaining({ type: "custom_tool_call", name: "edit", input: "abc" }),
		);
	});
});
