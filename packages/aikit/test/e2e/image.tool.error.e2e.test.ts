import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import Type from "typebox";
import { describe, expect, it } from "vite-plus/test";
import * as Message from "../../src/message/message.ts";
import * as Model from "../../src/model/model.ts";
import { complete } from "../../src/stream.ts";
import {
	ANTHROPIC_E2E_MODELS,
	anthropicOptions,
	describeIfAnthropic,
	describeIfGoogle,
	describeIfOpenAI,
	describeIfOpenAICodex,
	describeIfOpenRouter,
	getAnthropicModel,
	getGoogleModel,
	getOpenAICodexModel,
	getOpenAIModel,
	getOpenRouterModel,
	getText,
	googleOptions,
	openaiCodexOptions,
	openaiOptions,
	openrouterOptions,
	type StreamableModel,
} from "../utils/llm.ts";

const image = readFileSync(fileURLToPath(new URL("../data/red-circle.png", import.meta.url))).toString("base64");

function failToolCall(message: Message.AssistantMessage, callID: string): Message.AssistantMessage {
	return {
		...message,
		parts: message.parts.map((part) => {
			if (part.type !== "toolCall" || part.callID !== callID) return part;
			return {
				...part,
				status: "error",
				result: {
					content: [
						{ type: "text", text: "Screenshot assertion failed: the page did not match." },
						{ type: "image", data: image, mimeType: "image/png" },
					],
					isError: true,
				},
				time: { ...part.time, end: Date.now() },
			} satisfies Message.ToolCallErrorPart;
		}),
	};
}

/** Records each request body the provider SDK sends (Codex zstd-compresses its own), then forwards it. */
function recordRequests() {
	const bodies: Array<Record<string, unknown>> = [];
	const record: typeof fetch = (input, init) => {
		const body = init?.body;
		if (typeof body === "string") bodies.push(JSON.parse(body));
		else if (body instanceof Uint8Array) bodies.push(JSON.parse(zstdDecompressSync(body).toString()));
		return fetch(input, init);
	};
	return { bodies, fetch: record };
}

/** The provider payload after the assistant's tool call: what the model reads for the failed result. */
type Tail = (body: Record<string, unknown>) => unknown;
const after =
	(key: string, isCall: (item: unknown) => boolean): Tail =>
	(body) => {
		const items = body[key] as unknown[];
		return items.slice(items.findLastIndex(isCall) + 1);
	};
const has = (pattern: string) => (item: unknown) => JSON.stringify(item).includes(pattern);
const anthropicTail = after("messages", has('"type":"tool_use"'));
const responsesTail = after("input", has('"type":"function_call"'));
const chatTail = after("messages", has('"tool_calls"'));
const googleTail = after("contents", has('"functionCall"'));

/*
 * A failed tool call that still returns a screenshot: the model must see the
 * image whether the wire carries it in the error result or after it.
 */
async function handleErrorToolWithImageResult(model: StreamableModel, options: object, name: string, tail: Tail) {
	expect(model.input).toContain("image");
	const context: Message.Context = {
		systemPrompt: "You are a helpful assistant that uses tools when asked.",
		messages: [
			Message.createUserMessage({
				role: "user",
				parts: [
					{
						type: "text",
						text: "Call the check_screenshot tool once. It may fail; either way, describe the shape and color in its screenshot.",
					},
				],
				time: { created: Date.now() },
			}),
		],
		tools: [
			Message.defineTool({
				name: "check_screenshot",
				description: "Takes a screenshot and checks it against the expected page",
				parameters: Type.Object({}),
			}),
		],
	};

	const first = await complete(model, context, options as never);
	expect(first.stopReason, first.errorMessage).toBe("toolUse");
	const toolCall = first.parts.find((part): part is Message.ToolCall => part.type === "toolCall");
	if (!toolCall) throw new Error("expected tool call");
	context.messages.push(failToolCall(first, toolCall.callID));

	const requests = recordRequests();
	const second = await complete(model, context, {
		...options,
		factoryOptions: { ...(options as { factoryOptions?: object }).factoryOptions, fetch: requests.fetch },
	} as never);
	const body = requests.bodies.at(-1);
	if (!body) throw new Error("expected a recorded request");
	const ids = toolCall.callID.split("|").filter((id) => id.length > 0);
	const normalized = ids.reduce(
		(json, id, index) => json.replaceAll(id, `<call-id-${index}>`),
		JSON.stringify(tail(body), null, "\t").replaceAll(image, "<red-circle.png>"),
	);
	await expect(normalized).toMatchFileSnapshot(`./__artifacts__/error-tool-image.${name}.json`);

	expect(second.stopReason, second.errorMessage).toBe("stop");
	const text = getText(second).toLowerCase();
	expect(text).toContain("red");
	expect(text).toMatch(/circle|dot|disc|disk|round/);
}

describe("Error tool results with images", () => {
	describeIfAnthropic("Anthropic provider", () => {
		it(ANTHROPIC_E2E_MODELS[0], { retry: 2, timeout: 60_000 }, async () => {
			const model = await getAnthropicModel(ANTHROPIC_E2E_MODELS[0]);
			await handleErrorToolWithImageResult(model, anthropicOptions({ maxTokens: 256 }), "anthropic", anthropicTail);
		});
	});

	describeIfOpenAI("OpenAI provider", () => {
		it("gpt-6-luna", { retry: 2, timeout: 60_000 }, async () => {
			const model = await getOpenAIModel("gpt-6-luna");
			await handleErrorToolWithImageResult(model, openaiOptions({ maxTokens: 1_024 }), "openai", responsesTail);
		});
	});

	describeIfOpenAI("OpenAI Chat Completions", () => {
		it("gpt-6-luna", { retry: 2, timeout: 60_000 }, async () => {
			const model = await getOpenAIModel("gpt-6-luna");
			// gpt-6-luna takes no function tools with a reasoning effort on Chat Completions.
			const { reasoning: _, ...options } = openaiOptions({ maxTokens: 1_024, method: Model.APIMethodEnum.chat });
			await handleErrorToolWithImageResult(model, options, "openai-chat", chatTail);
		});
	});

	describeIfOpenAICodex("OpenAI Codex provider", () => {
		it("gpt-6-luna", { retry: 2, timeout: 120_000 }, async () => {
			const model = await getOpenAICodexModel("gpt-6-luna");
			await handleErrorToolWithImageResult(model, openaiCodexOptions(), "openai-codex", responsesTail);
		});
	});

	describeIfOpenRouter("OpenRouter provider", () => {
		it("meta/muse-spark-1.3-contributor", { retry: 2, timeout: 60_000 }, async () => {
			const model = await getOpenRouterModel("meta/muse-spark-1.3-contributor");
			await handleErrorToolWithImageResult(model, openrouterOptions(), "openrouter", chatTail);
		});
	});

	describeIfGoogle("Google provider (Gemini before 3)", () => {
		it("gemini-2.5-flash", { retry: 2, timeout: 90_000 }, async () => {
			const model = await getGoogleModel("gemini-2.5-flash");
			await handleErrorToolWithImageResult(
				model,
				googleOptions({ maxTokens: 4_096 }),
				"google-gemini-2",
				googleTail,
			);
		});
	});

	describeIfGoogle("Google provider", () => {
		it("gemini-3.5-flash", { retry: 2, timeout: 90_000 }, async () => {
			const model = await getGoogleModel("gemini-3.5-flash");
			await handleErrorToolWithImageResult(model, googleOptions({ maxTokens: 4_096 }), "google", googleTail);
		});
	});
});
