import "./utils/env";

import { describe, expect, it } from "vite-plus/test";
import { llm } from "../src/llm";
import type { AnthropicOptions, OpenAIOptions, OpenRouterOptions } from "../src/llm/options";
import { Protocol } from "../src/llm/protocol";
import { Message } from "../src/message/message";
import { Model } from "../src/model/model";
import { complete, stream } from "../src/stream";

type StreamOptionsWithExtras = Protocol.CommonOptions & Record<string, unknown>;

const describeIfAnthropic = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;
const describeIfOpenAI = process.env.OPENAI_API_KEY ? describe : describe.skip;
const describeIfOpenRouter = process.env.OPENROUTER_API_KEY ? describe : describe.skip;

function getGeneratedText(message: Message.AssistantMessage): string {
	return message.parts
		.flatMap((part) => {
			if (part.type === "text") return [part.text];
			if (part.type === "thinking") return [part.thinking];
			return [];
		})
		.join("");
}

async function testAbortSignal(model: Model.Info, options: StreamOptionsWithExtras = {}) {
	const context: Message.Context = {
		messages: [
			Message.createUserMessage({
				role: "user",
				parts: [
					{
						type: "text",
						text: "What is 15 + 27? Think step by step. Then list 100 first names.",
					},
				],
				time: {
					created: Date.now(),
				},
			}),
		],
		systemPrompt: "You are a helpful assistant.",
	};

	let abortFired = false;
	let text = "";
	const controller = new AbortController();
	const response = stream(model, context, { maxTokens: 512, ...options, signal: controller.signal });
	for await (const event of response) {
		if (event.type === "text.delta" || event.type === "thinking.delta") {
			text += event.delta;
		}
		if (!abortFired && text.length >= 1) {
			controller.abort();
			abortFired = true;
		}
	}
	const msg = await response.result();

	expect(abortFired).toBe(true);
	expect(msg.stopReason).toBe("aborted");
	expect(getGeneratedText(msg).length).toBeGreaterThan(0);

	context.messages.push(msg);
	context.messages.push(
		Message.createUserMessage({
			role: "user",
			parts: [
				{
					type: "text",
					text: "Please continue, but only generate 5 names.",
				},
			],
			time: {
				created: Date.now(),
			},
		}),
	);

	const followUp = await complete(model, context, { maxTokens: 256, ...options });
	expect(followUp.stopReason).toBe("stop");
	expect(getGeneratedText(followUp).length).toBeGreaterThan(0);
}

async function testImmediateAbort(model: Model.Info, options: StreamOptionsWithExtras = {}) {
	const controller = new AbortController();
	controller.abort();

	const context: Message.Context = {
		messages: [
			Message.createUserMessage({
				role: "user",
				parts: [
					{
						type: "text",
						text: "Hello",
					},
				],
				time: {
					created: Date.now(),
				},
			}),
		],
	};

	const response = await complete(model, context, { ...options, signal: controller.signal });
	expect(response.stopReason).toBe("aborted");
}

async function testAbortThenNewMessage(model: Model.Info, options: StreamOptionsWithExtras = {}) {
	const controller = new AbortController();
	controller.abort();

	const context: Message.Context = {
		messages: [
			Message.createUserMessage({
				role: "user",
				parts: [
					{
						type: "text",
						text: "Hello, how are you?",
					},
				],
				time: {
					created: Date.now(),
				},
			}),
		],
	};

	const abortedResponse = await complete(model, context, { ...options, signal: controller.signal });
	expect(abortedResponse.stopReason).toBe("aborted");
	expect(getGeneratedText(abortedResponse).length).toBe(0);

	context.messages.push(abortedResponse);
	context.messages.push(
		Message.createUserMessage({
			role: "user",
			parts: [
				{
					type: "text",
					text: "What is 2 + 2?",
				},
			],
			time: {
				created: Date.now(),
			},
		}),
	);

	const followUp = await complete(model, context, { maxTokens: 128, ...options });
	expect(followUp.stopReason).toBe("stop");
	expect(getGeneratedText(followUp).length).toBeGreaterThan(0);
}

function assertAnthropicModel(
	model: Model.Info | undefined,
): asserts model is Model.TModel<typeof Model.KnownProviderEnum.anthropic> {
	if (!model) {
		throw new Error("Expected Anthropic model to be defined");
	}
	if (model.protocol !== Model.KnownProviderEnum.anthropic) {
		throw new Error(`Expected anthropic protocol, received ${model.protocol}`);
	}
}

function assertOpenAIModel(
	model: Model.Info | undefined,
): asserts model is Model.TModel<typeof Model.KnownProviderEnum.openai> {
	if (!model) {
		throw new Error("Expected OpenAI model to be defined");
	}
	if (model.protocol !== Model.KnownProviderEnum.openai) {
		throw new Error(`Expected openai protocol, received ${model.protocol}`);
	}
}

function assertOpenRouterModel(
	model: Model.Info | undefined,
): asserts model is Model.TModel<typeof Model.KnownProviderEnum.openrouter> {
	if (!model) {
		throw new Error("Expected OpenRouter model to be defined");
	}
	if (model.protocol !== Model.KnownProviderEnum.openrouter) {
		throw new Error(`Expected openai protocol, received ${model.protocol}`);
	}
}

async function getAnthropicModel(): Promise<Model.TModel<typeof Model.KnownProviderEnum.anthropic>> {
	const model = await llm("anthropic", "claude-haiku-4-5-20251001");
	assertAnthropicModel(model);
	return model;
}

async function getOpenAIModel(): Promise<Model.TModel<typeof Model.KnownProviderEnum.openai>> {
	const model = await llm("openai", "gpt-4o-mini");
	assertOpenAIModel(model);
	return model;
}

async function getOpenRouterModel(): Promise<Model.TModel<typeof Model.KnownProviderEnum.openrouter>> {
	const model = await llm("openrouter", "deepseek/deepseek-v4-flash");
	assertOpenRouterModel(model);
	return model;
}

describe("AI Provider Abort Tests", () => {
	describeIfAnthropic("Anthropic provider (claude-haiku-4-5-20251001)", () => {
		const options: AnthropicOptions = {
			apiKey: process.env.ANTHROPIC_API_KEY,
		};

		it("should abort mid-stream", { retry: 3, timeout: 30000 }, async () => {
			const model = await getAnthropicModel();
			await testAbortSignal(model, options);
		});

		it("should handle immediate abort", { retry: 3, timeout: 30000 }, async () => {
			const model = await getAnthropicModel();
			await testImmediateAbort(model, options);
		});

		it("should handle abort then new message", { retry: 3, timeout: 30000 }, async () => {
			const model = await getAnthropicModel();
			await testAbortThenNewMessage(model, options);
		});
	});

	describeIfOpenAI("OpenAI provider (gpt-4o-mini)", () => {
		const options: OpenAIOptions = {
			apiKey: process.env.OPENAI_API_KEY,
		};

		it("should abort mid-stream", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIModel();
			await testAbortSignal(model, options);
		});

		it("should handle immediate abort", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIModel();
			await testImmediateAbort(model, options);
		});

		it("should handle abort then new message", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIModel();
			await testAbortThenNewMessage(model, options);
		});
	});

	describeIfOpenRouter("OpenRouter provider (deepseek/deepseek-v4-flash)", () => {
		const options: OpenRouterOptions = {
			apiKey: process.env.OPENROUTER_API_KEY,
			headers: {
				"HTTP-Referer": "https://www.codework.sh",
				"X-OpenRouter-Title": "CodeWork",
				"X-OpenRouter-Categories": "cli-agent,personal-agent",
			},
		};

		it("should abort mid-stream", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenRouterModel();
			await testAbortSignal(model, options);
		});

		it("should handle immediate abort", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenRouterModel();
			await testImmediateAbort(model, options);
		});

		it("should handle abort then new message", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenRouterModel();
			await testAbortThenNewMessage(model, options);
		});
	});
});
