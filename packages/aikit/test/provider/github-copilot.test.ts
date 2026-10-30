import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	GITHUB_COPILOT_API_VERSION,
	GITHUB_COPILOT_STATIC_HEADERS,
	createCopilotFetch,
	createGitHubCopilot,
} from "../../src/providers/github-copilot/index.ts";
import { stream } from "../../src/stream.ts";
import { makeModel, makeUserMessage } from "../utils/fixtures.ts";
import {
	openAICodexSSEResponse,
	openAICodexTextEvents,
	openAICodexUserPrompt,
	readOpenAICodexStream,
} from "../utils/openai-codex.ts";

type CapturedRequest = { url: string; headers: Headers; body: unknown };

function capture(): { requests: CapturedRequest[]; send: typeof globalThis.fetch } {
	const requests: CapturedRequest[] = [];
	const send: typeof globalThis.fetch = async (input, init) => {
		const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
		requests.push({
			url,
			headers: new Headers(init?.headers),
			body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
		});
		return Response.json({ ok: true });
	};
	return { requests, send };
}

const CHAT_URL = "https://api.githubcopilot.com/chat/completions";
const RESPONSES_URL = "https://api.githubcopilot.com/responses";
const MESSAGES_URL = "https://api.githubcopilot.com/v1/messages";

describe("createCopilotFetch", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("rewrites adapter auth headers to the Copilot bearer token", async () => {
		const { requests, send } = capture();
		const wrapped = createCopilotFetch({ apiKey: "ghu_test", fetch: send });

		await wrapped(CHAT_URL, {
			method: "POST",
			headers: { Authorization: "Bearer placeholder", "x-api-key": "placeholder" },
			body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
		});

		const headers = requests[0]!.headers;
		expect(headers.get("authorization")).toBe("Bearer ghu_test");
		expect(headers.get("x-api-key")).toBeNull();
		expect(headers.get("user-agent")).toBe(GITHUB_COPILOT_STATIC_HEADERS["User-Agent"]);
		expect(headers.get("editor-version")).toBe(GITHUB_COPILOT_STATIC_HEADERS["Editor-Version"]);
		expect(headers.get("copilot-integration-id")).toBe(GITHUB_COPILOT_STATIC_HEADERS["Copilot-Integration-Id"]);
		expect(headers.get("openai-intent")).toBe("conversation-edits");
		expect(headers.get("x-github-api-version")).toBe(GITHUB_COPILOT_API_VERSION);
		expect(headers.get("x-interaction-type")).toBe("conversation-agent");
	});

	it("marks chat bodies user-initiated and tool loops agent-initiated", async () => {
		const { requests, send } = capture();
		const wrapped = createCopilotFetch({ apiKey: "t", fetch: send });

		await wrapped(CHAT_URL, {
			method: "POST",
			body: JSON.stringify({ messages: [{ role: "user", content: "summarize" }] }),
		});
		expect(requests[0]!.headers.get("x-initiator")).toBe("user");

		await wrapped(CHAT_URL, {
			method: "POST",
			body: JSON.stringify({
				messages: [
					{ role: "user", content: "run tests" },
					{ role: "assistant", content: null, tool_calls: [] },
					{ role: "tool", content: "ok" },
				],
			}),
		});
		expect(requests[1]!.headers.get("x-initiator")).toBe("agent");
	});

	it("keeps a declared agent initiator on user-shaped bodies", async () => {
		const { requests, send } = capture();
		const wrapped = createCopilotFetch({ apiKey: "t", fetch: send });
		await wrapped(CHAT_URL, {
			method: "POST",
			headers: { "x-initiator": "agent" },
			body: JSON.stringify({ messages: [{ role: "user", content: "summarize" }] }),
		});
		expect(requests[0]!.headers.get("x-initiator")).toBe("agent");
	});

	it("classifies messages-endpoint tool results as agent turns", async () => {
		const { requests, send } = capture();
		const wrapped = createCopilotFetch({ apiKey: "t", fetch: send });
		await wrapped(MESSAGES_URL, {
			method: "POST",
			body: JSON.stringify({
				model: "claude-sonnet-4.6",
				messages: [{ role: "user", content: [{ type: "tool_result", content: "done" }] }],
			}),
		});
		expect(requests[0]!.headers.get("x-initiator")).toBe("agent");
	});

	it("classifies responses input by its last item role", async () => {
		const { requests, send } = capture();
		const wrapped = createCopilotFetch({ apiKey: "t", fetch: send });
		await wrapped(RESPONSES_URL, {
			method: "POST",
			body: JSON.stringify({ input: [{ role: "user", content: "hi" }] }),
		});
		expect(requests[0]!.headers.get("x-initiator")).toBe("user");

		await wrapped(RESPONSES_URL, {
			method: "POST",
			body: JSON.stringify({
				input: [
					{ role: "user", content: "hi" },
					{ type: "function_call_output", call_id: "c", output: "ok" },
				],
			}),
		});
		expect(requests[1]!.headers.get("x-initiator")).toBe("agent");
	});

	it("flags vision requests per endpoint payload shape", async () => {
		const { requests, send } = capture();
		const wrapped = createCopilotFetch({ apiKey: "t", fetch: send });

		await wrapped(CHAT_URL, {
			method: "POST",
			body: JSON.stringify({
				messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:..." } }] }],
			}),
		});
		expect(requests[0]!.headers.get("copilot-vision-request")).toBe("true");

		await wrapped(RESPONSES_URL, {
			method: "POST",
			body: JSON.stringify({
				input: [{ role: "user", content: [{ type: "input_image", image_url: "data:..." }] }],
			}),
		});
		expect(requests[1]!.headers.get("copilot-vision-request")).toBe("true");

		await wrapped(MESSAGES_URL, {
			method: "POST",
			body: JSON.stringify({
				model: "claude-sonnet-4.6",
				messages: [{ role: "user", content: [{ type: "tool_result", content: [{ type: "image" }] }] }],
			}),
		});
		expect(requests[2]!.headers.get("copilot-vision-request")).toBe("true");

		await wrapped(CHAT_URL, {
			method: "POST",
			body: JSON.stringify({ messages: [{ role: "user", content: "text only" }] }),
		});
		expect(requests[3]!.headers.get("copilot-vision-request")).toBeNull();
	});

	it("sends X-Interaction-Id and escalates non-agent interaction types", async () => {
		const { requests, send } = capture();
		const wrapped = createCopilotFetch({
			apiKey: "t",
			fetch: send,
			sessionId: "session-1",
			interactionType: "subagent",
		});
		await wrapped(CHAT_URL, {
			method: "POST",
			body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
		});
		const headers = requests[0]!.headers;
		expect(headers.get("x-interaction-id")).toBe("session-1");
		expect(headers.get("x-interaction-type")).toBe("conversation-subagent");
		expect(headers.get("x-initiator")).toBe("agent");
	});

	it("strips betas Copilot rejects on adaptive Claude models only", async () => {
		const { requests, send } = capture();
		const wrapped = createCopilotFetch({ apiKey: "t", fetch: send });
		const beta = "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14";

		await wrapped(MESSAGES_URL, {
			method: "POST",
			headers: { "anthropic-beta": beta },
			body: JSON.stringify({ model: "claude-opus-4.8", messages: [] }),
		});
		expect(requests[0]!.headers.get("anthropic-beta")).toBeNull();

		await wrapped(MESSAGES_URL, {
			method: "POST",
			headers: { "anthropic-beta": "prompt-caching-2024-07-31,fine-grained-tool-streaming-2025-05-14" },
			body: JSON.stringify({ model: "claude-opus-4.8", messages: [] }),
		});
		expect(requests[1]!.headers.get("anthropic-beta")).toBe("prompt-caching-2024-07-31");

		await wrapped(MESSAGES_URL, {
			method: "POST",
			headers: { "anthropic-beta": beta },
			body: JSON.stringify({ model: "claude-haiku-4.5", messages: [] }),
		});
		expect(requests[2]!.headers.get("anthropic-beta")).toBe(beta);
	});
});

describe("GitHub Copilot Responses", () => {
	const sse = (events: Array<Record<string, unknown>>) => {
		const bodies: Array<Record<string, unknown>> = [];
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
			return openAICodexSSEResponse(events);
		};
		return { bodies, fetch };
	};
	const responses = (fetch: typeof globalThis.fetch) =>
		createGitHubCopilot({ apiKey: "ghu_test", fetch }).responses("gpt-6-luna");

	it("keeps one tool call when Copilot rotates the item id on every event", async () => {
		const { fetch } = sse([
			{ type: "response.created", response: { id: "resp_1", model: "gpt-6-luna" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_a", call_id: "call_1", name: "math", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_b", output_index: 0, delta: '{"a":' },
			{ type: "response.function_call_arguments.delta", item_id: "fc_c", output_index: 0, delta: "15}" },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "function_call", id: "fc_d", call_id: "call_1", name: "math", arguments: '{"a":15}' },
			},
			{
				type: "response.completed",
				response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
			},
		]);
		const { stream: parts } = await responses(fetch).doStream({ prompt: openAICodexUserPrompt });
		const calls = (await readOpenAICodexStream(parts)).filter((part) => part.type === "tool-call");

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ toolName: "math", input: '{"a":15}' });
	});

	it("sends tool fields only for a tool choice the call names", async () => {
		const { bodies, fetch } = sse(openAICodexTextEvents);
		const model = responses(fetch);
		await model.doStream({ prompt: openAICodexUserPrompt });
		await model.doStream({
			prompt: openAICodexUserPrompt,
			tools: [{ type: "function", name: "math", inputSchema: { type: "object", properties: {} } }],
			toolChoice: { type: "auto" },
		});

		// Grok on Copilot rejects either field on a request without tools.
		expect(bodies[0]).not.toHaveProperty("tool_choice");
		expect(bodies[0]).not.toHaveProperty("parallel_tool_calls");
		expect(bodies[1]).toMatchObject({ tool_choice: "auto" });
		expect(bodies[1]).not.toHaveProperty("parallel_tool_calls");
	});

	it("turns reasoning off with the model's off effort", async () => {
		const { bodies, fetch } = sse(openAICodexTextEvents);
		const model = makeModel({
			id: "gpt-6-luna",
			provider: { id: "github-copilot", name: "GitHub Copilot", source: "custom", env: [] },
			npm: "@codeworksh/ai-sdk-github-copilot",
			api: { id: "gpt-6-luna", method: "responses" },
			protocol: "github-copilot",
			providerOptionsKey: "github-copilot",
			reasoning: true,
			thinkingLevelMap: { off: "none" },
		});
		const off = await stream.complete(
			model,
			{ messages: [makeUserMessage("hi")] },
			{ apiKey: "ghu_test", factoryOptions: { fetch } },
		);
		const cannotDisable = await stream.complete(
			{ ...model, thinkingLevelMap: { off: null } },
			{ messages: [makeUserMessage("hi")] },
			{ apiKey: "ghu_test", factoryOptions: { fetch } },
		);

		expect(off.stopReason, off.errorMessage).toBe("stop");
		expect(cannotDisable.stopReason, cannotDisable.errorMessage).toBe("stop");
		expect(bodies[0]).toMatchObject({ reasoning: { effort: "none" } });
		expect(bodies[1]).not.toHaveProperty("reasoning");
	});
});
