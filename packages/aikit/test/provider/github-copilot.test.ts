import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	GITHUB_COPILOT_API_VERSION,
	GITHUB_COPILOT_STATIC_HEADERS,
	createCopilotFetch,
} from "../../src/providers/github-copilot/index.ts";

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
