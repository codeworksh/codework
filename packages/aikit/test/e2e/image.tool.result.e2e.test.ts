import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Type from "typebox";
import { describe, expect, it } from "vite-plus/test";
import type { AnthropicOptions, OpenAICodexOptions, OpenAIOptions } from "../../src/llm/options.ts";
import * as Message from "../../src/message/message.ts";
import * as Model from "../../src/model/model.ts";
import { convertMessages } from "../../src/llm/transform.ts";
import { complete } from "../../src/stream.ts";
import { makeAssistantMessage, makeCompletedToolCall } from "../utils/fixtures.ts";
import {
	ANTHROPIC_E2E_MODELS,
	anthropicOptions,
	describeIfAnthropic,
	describeIfOpenAI,
	describeIfOpenAICodex,
	describeIfOpenRouter,
	OPENROUTER_E2E_MODELS,
	getAnthropicModel,
	getOpenAIModel,
	getOpenAICodexModel,
	getOpenRouterModel,
	getText,
	OPENAI_CODEX_E2E_MODELS,
	OPENAI_E2E_MODELS,
	openaiCodexOptions,
	openaiOptions,
	openrouterOptions,
} from "../utils/llm.ts";

type SupportedModel =
	| Model.TModel<typeof Model.KnownProviderEnum.anthropic>
	| Model.TModel<typeof Model.KnownProviderEnum.openai>
	| Model.TModel<typeof Model.KnownProviderEnum.openaiCodex>
	| Model.TModel<typeof Model.KnownProviderEnum.openrouter>;
type SupportedOptions = AnthropicOptions | OpenAICodexOptions | OpenAIOptions;

function getImageBase64(): string {
	const imagePath = fileURLToPath(new URL("../data/red-circle.png", import.meta.url));
	return readFileSync(imagePath).toString("base64");
}

function completeToolCall(
	message: Message.AssistantMessage,
	toolCall: Message.ToolCall,
	content: Array<Message.TextContent | Message.ImageContent>,
): Message.AssistantMessage {
	const now = Date.now();
	return {
		...message,
		parts: message.parts.map((part) => {
			if (part.type !== "toolCall" || part.callID !== toolCall.callID) return part;
			return {
				...part,
				status: "completed",
				result: {
					content,
					isError: false,
				},
				time: {
					...part.time,
					end: now,
				},
			} satisfies Message.ToolCallCompletedPart;
		}),
	};
}

async function completeWithTransientRetry(model: SupportedModel, context: Message.Context, options: SupportedOptions) {
	for (let attempt = 0; ; attempt++) {
		const response = await complete(model, context, options as never);
		const overloaded =
			response.errorMessage?.includes("server_is_overloaded") ||
			response.errorMessage?.includes("servers are currently overloaded");
		if (!overloaded || attempt >= 3) return response;
		await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
	}
}

async function handleToolWithImageResult(model: SupportedModel, options: SupportedOptions) {
	expect(model.input).toContain("image");

	const getImageTool = Message.defineTool({
		name: "get_circle",
		description: "Returns a circle image for visualization",
		parameters: Type.Object({}),
	});

	const context: Message.Context = {
		systemPrompt: "You are a helpful assistant that uses tools when asked.",
		messages: [
			Message.createUserMessage({
				role: "user",
				parts: [
					{
						type: "text",
						text: "Call the get_circle tool to get an image, then describe the shape and color you see.",
					},
				],
				time: { created: Date.now() },
			}),
		],
		tools: [getImageTool],
	};

	const firstResponse = await completeWithTransientRetry(model, context, options);
	expect(firstResponse.stopReason, firstResponse.errorMessage).toBe("toolUse");

	const toolCall = firstResponse.parts.find((block): block is Message.ToolCall => block.type === "toolCall");
	expect(toolCall).toBeTruthy();
	if (!toolCall) throw new Error("expected tool call");
	expect(toolCall.name).toBe("get_circle");

	context.messages.push(
		completeToolCall(firstResponse, toolCall, [
			{
				type: "image",
				data: getImageBase64(),
				mimeType: "image/png",
			},
		]),
	);

	const secondResponse = await completeWithTransientRetry(model, context, options);
	expect(secondResponse.stopReason, secondResponse.errorMessage).toBe("stop");
	expect(secondResponse.errorMessage).toBeFalsy();

	const text = getText(secondResponse).toLowerCase();
	expect(text).toContain("red");
	expect(text).toMatch(/circle|dot|disc|disk|round/);
}

async function handleToolWithTextAndImageResult(model: SupportedModel, options: SupportedOptions) {
	expect(model.input).toContain("image");

	const getImageTool = Message.defineTool({
		name: "get_circle_with_description",
		description: "Returns a circle image with a text description",
		parameters: Type.Object({}),
	});

	const context: Message.Context = {
		systemPrompt: "You are a helpful assistant that uses tools when asked.",
		messages: [
			Message.createUserMessage({
				role: "user",
				parts: [
					{
						type: "text",
						text: "Use the get_circle_with_description tool and tell me the shape color plus the image metadata.",
					},
				],
				time: { created: Date.now() },
			}),
		],
		tools: [getImageTool],
	};

	const firstResponse = await completeWithTransientRetry(model, context, options);
	expect(firstResponse.stopReason, firstResponse.errorMessage).toBe("toolUse");

	const toolCall = firstResponse.parts.find((block): block is Message.ToolCall => block.type === "toolCall");
	expect(toolCall).toBeTruthy();
	if (!toolCall) throw new Error("expected tool call");
	expect(toolCall.name).toBe("get_circle_with_description");

	context.messages.push(
		completeToolCall(firstResponse, toolCall, [
			{
				type: "text",
				text: "This is a geometric shape with specific properties: it has a diameter of 100 pixels.",
			},
			{
				type: "image",
				data: getImageBase64(),
				mimeType: "image/png",
			},
		]),
	);

	const secondResponse = await completeWithTransientRetry(model, context, options);
	expect(secondResponse.stopReason, secondResponse.errorMessage).toBe("stop");
	expect(secondResponse.errorMessage).toBeFalsy();

	const text = getText(secondResponse).toLowerCase();
	expect(text).toMatch(/diameter|100|pixel/);
	expect(text).toContain("red");
	expect(text).toMatch(/circle|dot|disc|disk|round/);
}

/*
 * A vision model with `input` narrowed to text stands in for a text-only
 * model: the provider must accept the history with every image replaced by a
 * placeholder, and the model must be able to read those placeholders back.
 */
async function handleImagesOnTextOnlyModel(model: SupportedModel, options: SupportedOptions, name: string) {
	const textOnly = { ...model, input: ["text" as const] };
	const image = { type: "image" as const, data: getImageBase64(), mimeType: "image/png" };
	const context: Message.Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			Message.createUserMessage({
				role: "user",
				parts: [{ type: "text", text: "Here are two photos." }, image, image],
				time: { created: Date.now() },
			}),
			makeAssistantMessage(textOnly, {
				stopReason: "toolUse",
				parts: [
					makeCompletedToolCall("call_screenshot", "screenshot", [{ type: "text", text: "rendered" }, image]),
				],
			}),
			Message.createUserMessage({
				role: "user",
				parts: [
					{
						type: "text",
						text: "Quote verbatim every parenthesised note in this conversation, one per line, and nothing else.",
					},
				],
				time: { created: Date.now() },
			}),
		],
		tools: [
			Message.defineTool({ name: "screenshot", description: "Takes a screenshot", parameters: Type.Object({}) }),
		],
	};

	const wire = convertMessages(context, textOnly);
	expect(JSON.stringify(wire)).not.toContain(image.data);
	await expect(JSON.stringify(wire, null, "\t")).toMatchFileSnapshot(`./__artifacts__/text-only-images.${name}.json`);

	const response = await completeWithTransientRetry(textOnly, context, options);
	expect(response.stopReason, response.errorMessage).toBe("stop");
	expect(getText(response).toLowerCase()).toContain("image omitted: model does not support images");
}

const OPENROUTER_IMAGE_MODELS = OPENROUTER_E2E_MODELS.filter((id) => id !== "google/gemini-3.8-flash");

describe("Tool Results with Images", () => {
	describeIfOpenAI.each(OPENAI_E2E_MODELS)("OpenAI provider (%s)", (modelId) => {
		const options = openaiOptions({ maxTokens: 256 });

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIModel(modelId);
			await handleToolWithImageResult(model, options);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIModel(modelId);
			await handleToolWithTextAndImageResult(model, options);
		});

		it("should replace images with placeholders for a text-only model", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIModel(modelId);
			await handleImagesOnTextOnlyModel(model, options, "openai");
		});
	});

	describeIfAnthropic.each(ANTHROPIC_E2E_MODELS)("Anthropic provider (%s)", (modelId) => {
		const options = anthropicOptions({ maxTokens: 256, temperature: 0 });

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			const model = await getAnthropicModel(modelId);
			await handleToolWithImageResult(model, options);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			const model = await getAnthropicModel(modelId);
			await handleToolWithTextAndImageResult(model, options);
		});

		it.skipIf(modelId === "claude-haiku-5-5")(
			"should replace images with placeholders for a text-only model",
			{ retry: 3, timeout: 30000 },
			async () => {
				const model = await getAnthropicModel(modelId);
				await handleImagesOnTextOnlyModel(model, options, "anthropic");
			},
		);
	});

	describeIfOpenAICodex.each(OPENAI_CODEX_E2E_MODELS)("OpenAI Codex provider (%s)", (modelId) => {
		const options = openaiCodexOptions();

		it("should handle tool result with only image", { retry: 2, timeout: 120_000 }, async () => {
			const model = await getOpenAICodexModel(modelId);
			await handleToolWithImageResult(model, options);
		});

		it("should handle tool result with text and image", { retry: 2, timeout: 120_000 }, async () => {
			const model = await getOpenAICodexModel(modelId);
			await handleToolWithTextAndImageResult(model, options);
		});

		it("should replace images with placeholders for a text-only model", { retry: 2, timeout: 120_000 }, async () => {
			const model = await getOpenAICodexModel(modelId);
			await handleImagesOnTextOnlyModel(model, options, "openai-codex");
		});
	});

	describeIfOpenRouter.each(OPENROUTER_IMAGE_MODELS)("OpenRouter provider (%s)", (modelId) => {
		const options = openrouterOptions();

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenRouterModel(modelId);
			await handleToolWithImageResult(model, options);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenRouterModel(modelId);
			await handleToolWithTextAndImageResult(model, options);
		});

		it("should replace images with placeholders for a text-only model", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenRouterModel(modelId);
			await handleImagesOnTextOnlyModel(model, options, "openrouter");
		});
	});
});
