import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { zstdDecompressSync } from "node:zlib";

function makeJwt(payload: Record<string, unknown>): string {
	const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

export const OPENAI_CODEX_TEST_ACCOUNT_ID = "acct_test_123";
export const OPENAI_CODEX_TEST_API_KEY = makeJwt({
	"https://api.openai.com/auth": { chatgpt_account_id: OPENAI_CODEX_TEST_ACCOUNT_ID },
});

export function openAICodexSSEBody(events: Array<Record<string, unknown>>): string {
	return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

export function openAICodexSSEResponse(events: Array<Record<string, unknown>>): Response {
	return new Response(openAICodexSSEBody(events), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

export type OpenAICodexFetchCall = {
	url: string;
	init: RequestInit & { headers: Record<string, string> };
};

export function createOpenAICodexMockFetch(responses: Response | Response[]): {
	fetch: typeof globalThis.fetch;
	calls: OpenAICodexFetchCall[];
	body: (index?: number) => Record<string, unknown>;
} {
	const queue = Array.isArray(responses) ? [...responses] : [responses];
	const calls: OpenAICodexFetchCall[] = [];
	const mock = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const target = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
		calls.push({ url: target, init: (init ?? {}) as OpenAICodexFetchCall["init"] });
		const next = queue.shift();
		if (!next) throw new Error("mock fetch queue exhausted");
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

export async function readOpenAICodexStream(
	stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3StreamPart[]> {
	const parts: LanguageModelV3StreamPart[] = [];
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value);
	}
	return parts;
}

export const openAICodexUserPrompt: LanguageModelV3Prompt = [
	{ role: "system", content: "You are concise." },
	{ role: "user", content: [{ type: "text", text: "Hello" }] },
];

export const openAICodexDeferredToolsPrompt: LanguageModelV3Prompt = [
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

export const openAICodexDeferredTools = [
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

export const openAICodexTextEvents: Array<Record<string, unknown>> = [
	{ type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
	{
		type: "response.output_item.added",
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	},
	{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hello" },
	{
		type: "response.output_text.delta",
		item_id: "msg_1",
		output_index: 0,
		content_index: 0,
		delta: " world",
	},
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
