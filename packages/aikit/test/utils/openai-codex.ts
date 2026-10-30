import type {
	LanguageModelV3FunctionTool,
	LanguageModelV3Prompt,
	LanguageModelV3StreamPart,
	SharedV3ProviderOptions,
} from "@ai-sdk/provider";
import type { ResponsesToolChange } from "../../src/providers/responses/tools.ts";
import { zstdDecompressSync } from "node:zlib";
import { buildCatalog } from "../../src/cli/modelgen.ts";
import type * as Model from "../../src/model/model.ts";

function makeJwt(payload: Record<string, unknown>): string {
	const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

export const OPENAI_CODEX_TEST_ACCOUNT_ID = "acct_test_123";
export const OPENAI_CODEX_TEST_API_KEY = makeJwt({
	"https://api.openai.com/auth": { chatgpt_account_id: OPENAI_CODEX_TEST_ACCOUNT_ID },
});

/** The generated Codex entries, from a models.dev snapshot of the OpenAI models they build on. */
export function openAICodexModels(): Record<string, Model.Info> {
	const model = (id: string, input: string[]) => ({
		id,
		name: id,
		family: "gpt",
		attachment: true,
		reasoning: true,
		tool_call: true,
		release_date: "2026-01-01",
		last_updated: "2026-01-01",
		modalities: { input, output: ["text"] },
		open_weights: false,
		cost: { input: 1, output: 4, cache_read: 0.1 },
		limit: { context: 1_050_000, output: 128_000 },
	});
	const ids: Array<[string, string[]]> = [
		["gpt-5.3-codex-spark", ["text"]],
		["gpt-5.6-luna", ["text", "image"]],
		["gpt-6-luna", ["text", "image"]],
	];
	const catalog = buildCatalog({
		modelsDev: {
			openai: {
				id: "openai",
				name: "OpenAI",
				env: ["OPENAI_API_KEY"],
				npm: "@ai-sdk/openai",
				models: Object.fromEntries(ids.map(([id, input]) => [id, model(id, input)])),
			},
		},
	});
	return catalog["openai-codex"] ?? {};
}

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

function toolChangeMessage(
	mode: "changes" | "additions",
	tools: LanguageModelV3FunctionTool[],
	removed: string[] = [],
): LanguageModelV3Prompt[number] {
	const toolChange: ResponsesToolChange = { mode, tools, removed };
	// Function tools are plain JSON, as aikit builds them.
	return {
		role: "system",
		content: "",
		providerOptions: { "openai-codex": { toolChange } } as unknown as SharedV3ProviderOptions,
	};
}

/**
 * A transcript where `late_tool` is added after the first tool result. `changes` also declares
 * the initial `base_tool` in place at the head, as aikit does for that mode.
 */
export function openAICodexToolChangePrompt(
	mode: "changes" | "additions",
	lateTool: LanguageModelV3FunctionTool = openAICodexLoadableTools[1]!,
): LanguageModelV3Prompt {
	return [
		...(mode === "changes" ? [toolChangeMessage(mode, [openAICodexLoadableTools[0]!])] : []),
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
				},
			],
		},
		toolChangeMessage(mode, [lateTool]),
		{ role: "user", content: [{ type: "text", text: "Continue" }] },
	];
}

export const openAICodexLoadableTools: LanguageModelV3FunctionTool[] = [
	{
		type: "function",
		name: "base_tool",
		description: "Base tool",
		inputSchema: { type: "object", properties: {} },
	},
	{
		type: "function",
		name: "late_tool",
		description: "Late tool",
		inputSchema: { type: "object", properties: { value: { type: "string" } } },
	},
];

/** A `changes` transcript that removes `base_tool` and then adds `late_tool`. */
export const openAICodexToolRemovalPrompt: LanguageModelV3Prompt = [
	toolChangeMessage("changes", [openAICodexLoadableTools[0]!]),
	{ role: "user", content: [{ type: "text", text: "Use the tools" }] },
	toolChangeMessage("changes", [], ["base_tool"]),
	{ role: "user", content: [{ type: "text", text: "Next" }] },
	toolChangeMessage("changes", [openAICodexLoadableTools[1]!]),
	{ role: "user", content: [{ type: "text", text: "Continue" }] },
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
