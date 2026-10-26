import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Type from "typebox";
import { describe, expect, it } from "vite-plus/test";
import { convertMessages } from "../../src/llm/transform.ts";
import * as Message from "../../src/message/message.ts";
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

/*
 * A failed tool call that still returns a screenshot: the model must see the
 * image whether the wire carries it in the error result or after it.
 */
async function handleErrorToolWithImageResult(model: StreamableModel, options: object, name: string) {
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

	const wire = convertMessages(context, model);
	const results = wire.slice(wire.findIndex((message) => message.role === "tool"));
	const normalized = JSON.stringify(results, null, "\t")
		.replaceAll(image, "<red-circle.png>")
		.replaceAll(toolCall.callID, "<call-id>");
	await expect(normalized).toMatchFileSnapshot(`./__artifacts__/error-tool-image.${name}.json`);

	const second = await complete(model, context, options as never);
	expect(second.stopReason, second.errorMessage).toBe("stop");
	const text = getText(second).toLowerCase();
	expect(text).toContain("red");
	expect(text).toMatch(/circle|dot|disc|disk|round/);
}

describe("Error tool results with images", () => {
	describeIfAnthropic("Anthropic provider", () => {
		it(ANTHROPIC_E2E_MODELS[0], { retry: 2, timeout: 60_000 }, async () => {
			const model = await getAnthropicModel(ANTHROPIC_E2E_MODELS[0]);
			await handleErrorToolWithImageResult(model, anthropicOptions({ maxTokens: 256 }), "anthropic");
		});
	});

	describeIfOpenAI("OpenAI provider", () => {
		it("gpt-6-luna", { retry: 2, timeout: 60_000 }, async () => {
			const model = await getOpenAIModel("gpt-6-luna");
			await handleErrorToolWithImageResult(model, openaiOptions({ maxTokens: 1_024 }), "openai");
		});
	});

	describeIfOpenAICodex("OpenAI Codex provider", () => {
		it("gpt-6-luna", { retry: 2, timeout: 120_000 }, async () => {
			const model = await getOpenAICodexModel("gpt-6-luna");
			await handleErrorToolWithImageResult(model, openaiCodexOptions(), "openai-codex");
		});
	});

	describeIfOpenRouter("OpenRouter provider", () => {
		it("meta/muse-spark-1.3-contributor", { retry: 2, timeout: 60_000 }, async () => {
			const model = await getOpenRouterModel("meta/muse-spark-1.3-contributor");
			await handleErrorToolWithImageResult(model, openrouterOptions(), "openrouter");
		});
	});

	describeIfGoogle("Google provider", () => {
		it("gemini-3.5-flash", { retry: 2, timeout: 90_000 }, async () => {
			const model = await getGoogleModel("gemini-3.5-flash");
			await handleErrorToolWithImageResult(model, googleOptions({ maxTokens: 4_096 }), "google");
		});
	});
});
