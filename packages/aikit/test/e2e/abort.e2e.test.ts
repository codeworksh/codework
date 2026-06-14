import { describe, expect, it } from "vite-plus/test";
import { Protocol } from "../../src/llm/protocol";
import { Message } from "../../src/message/message";
import { complete, stream } from "../../src/stream";
import {
	anthropicOptions,
	describeIfAnthropic,
	describeIfOpenAI,
	describeIfOpenAICodex,
	describeIfOpenRouter,
	getAnthropicModel,
	getGeneratedText,
	getOpenAICodexModel,
	getOpenAIModel,
	getOpenRouterModel,
	openaiCodexOptions,
	openaiOptions,
	openrouterOptions,
	type StreamableModel,
} from "../utils/llm";

type StreamOptionsWithExtras = Protocol.CommonOptions & Record<string, unknown>;

async function testAbortSignal(model: StreamableModel, options: StreamOptionsWithExtras = {}) {
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

async function testImmediateAbort(model: StreamableModel, options: StreamOptionsWithExtras = {}) {
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

async function testAbortThenNewMessage(model: StreamableModel, options: StreamOptionsWithExtras = {}) {
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

describe("AI Provider Abort Tests", () => {
	describeIfAnthropic("Anthropic provider (claude-haiku-4-5-20251001)", () => {
		const options = anthropicOptions();

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
		const options = openaiOptions();

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

	describeIfOpenAICodex("OpenAI Codex provider (gpt-5.4)", () => {
		const options = openaiCodexOptions();

		it("should abort mid-stream", { retry: 3, timeout: 60000 }, async () => {
			const model = await getOpenAICodexModel();
			await testAbortSignal(model, options);
		});

		it("should handle immediate abort", { retry: 3, timeout: 60000 }, async () => {
			const model = await getOpenAICodexModel();
			await testImmediateAbort(model, options);
		});

		it("should handle abort then new message", { retry: 3, timeout: 60000 }, async () => {
			const model = await getOpenAICodexModel();
			await testAbortThenNewMessage(model, options);
		});
	});

	describeIfOpenRouter("OpenRouter provider (deepseek/deepseek-v4-flash)", () => {
		const options = openrouterOptions();

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
