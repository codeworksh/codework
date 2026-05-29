import "./utils/env";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Type from "typebox";
import { describe, expect, it } from "vite-plus/test";
import { llm } from "../src/llm";
import type { AnthropicOptions, OpenAIOptions, OpenRouterOptions } from "../src/llm/options";
import { Message } from "../src/message/message";
import { Model } from "../src/model/model";
import { complete } from "../src/stream";

const describeIfAnthropic = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;
const describeIfOpenAI = process.env.OPENAI_API_KEY ? describe : describe.skip;
const describeIfOpenRouter = process.env.OPENROUTER_API_KEY ? describe : describe.skip;

type SupportedModel =
	| Model.TModel<typeof Model.KnownProviderEnum.anthropic>
	| Model.TModel<typeof Model.KnownProviderEnum.openai>
	| Model.TModel<typeof Model.KnownProviderEnum.openrouter>;
type SupportedOptions = AnthropicOptions | OpenAIOptions;

function getImageBase64(): string {
	const imagePath = fileURLToPath(new URL("./data/red-circle.png", import.meta.url));
	return readFileSync(imagePath).toString("base64");
}

function getText(message: Message.AssistantMessage): string {
	return message.parts
		.filter((part): part is Message.TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
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

function assertProtocol<TProtocol extends Model.KnownProviderEnum>(
	model: Model.Info | undefined,
	protocol: TProtocol,
): asserts model is Model.TModel<TProtocol> {
	if (!model) throw new Error("Expected model to be defined");
	if (model.protocol !== protocol) throw new Error(`Expected ${protocol}, received ${model.protocol}`);
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

	const firstResponse = await complete(model, context, options as never);
	expect(firstResponse.stopReason, firstResponse.errorMessage).toBe("toolUse");

	const toolCall = firstResponse.parts.find((block): block is Message.ToolCall => block.type === "toolCall");
	expect(toolCall).toBeTruthy();
	if (!toolCall) throw new Error("Expected tool call");
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

	const secondResponse = await complete(model, context, options as never);
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

	const firstResponse = await complete(model, context, options as never);
	expect(firstResponse.stopReason, firstResponse.errorMessage).toBe("toolUse");

	const toolCall = firstResponse.parts.find((block): block is Message.ToolCall => block.type === "toolCall");
	expect(toolCall).toBeTruthy();
	if (!toolCall) throw new Error("Expected tool call");
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

	const secondResponse = await complete(model, context, options as never);
	expect(secondResponse.stopReason, secondResponse.errorMessage).toBe("stop");
	expect(secondResponse.errorMessage).toBeFalsy();

	const text = getText(secondResponse).toLowerCase();
	expect(text).toMatch(/diameter|100|pixel/);
	expect(text).toContain("red");
	expect(text).toMatch(/circle|dot|disc|disk|round/);
}

describe("Tool Results with Images", () => {
	describeIfOpenAI("OpenAI provider (gpt-4o-mini)", () => {
		const options: OpenAIOptions = {
			apiKey: process.env.OPENAI_API_KEY,
			maxTokens: 256,
			temperature: 0,
		};

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			const model = await llm("openai", "gpt-4o-mini");
			assertProtocol(model, Model.KnownProviderEnum.openai);
			await handleToolWithImageResult(model, options);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			const model = await llm("openai", "gpt-4o-mini");
			assertProtocol(model, Model.KnownProviderEnum.openai);
			await handleToolWithTextAndImageResult(model, options);
		});
	});

	describeIfAnthropic("Anthropic provider (claude-haiku-4-5-20251001)", () => {
		const options: AnthropicOptions = {
			apiKey: process.env.ANTHROPIC_API_KEY,
			maxTokens: 256,
			temperature: 0,
		};

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			const model = await llm("anthropic", "claude-haiku-4-5-20251001");
			assertProtocol(model, Model.KnownProviderEnum.anthropic);
			await handleToolWithImageResult(model, options);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			const model = await llm("anthropic", "claude-haiku-4-5-20251001");
			assertProtocol(model, Model.KnownProviderEnum.anthropic);
			await handleToolWithTextAndImageResult(model, options);
		});
	});

	describeIfOpenRouter("OpenRouter provider (z-ai/glm-4.6v)", () => {
		const options: OpenRouterOptions = {
			apiKey: process.env.OPENROUTER_API_KEY,
			headers: {
				"HTTP-Referer": "https://www.codework.sh",
				"X-OpenRouter-Title": "CodeWork",
				"X-OpenRouter-Categories": "cli-agent,personal-agent",
			},
		};

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			const model = await llm("openrouter", "z-ai/glm-4.6v");
			assertProtocol(model, Model.KnownProviderEnum.openrouter);
			await handleToolWithTextAndImageResult(model, options);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			const model = await llm("openrouter", "z-ai/glm-4.6v");
			assertProtocol(model, Model.KnownProviderEnum.openrouter);
			await handleToolWithTextAndImageResult(model, options);
		});
	});
});
