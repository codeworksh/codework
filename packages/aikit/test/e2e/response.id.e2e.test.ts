import { describe, expect, it } from "vite-plus/test";
import * as Protocol from "../../src/llm/protocol.ts";
import * as Message from "../../src/message/message.ts";
import { complete } from "../../src/stream.ts";
import {
	anthropicOptions,
	describeIfAnthropic,
	describeIfOpenAI,
	describeIfOpenAICodex,
	describeIfOpenRouter,
	getAnthropicModel,
	getOpenAICodexModel,
	getOpenAIModel,
	getOpenRouterModel,
	openaiCodexOptions,
	openaiOptions,
	openrouterOptions,
	type StreamableModel,
} from "../utils/llm.ts";

type StreamOptionsWithExtras = Protocol.CommonOptions & Record<string, unknown>;

async function expectResponseId(model: StreamableModel, options: StreamOptionsWithExtras = {}) {
	const context: Message.Context = {
		systemPrompt: "You are a helpful assistant. Be concise.",
		messages: [
			Message.createUserMessage({
				role: "user",
				time: {
					created: Date.now(),
				},
				parts: [
					{
						type: "text",
						text: "Reply with exactly: response id test",
					},
				],
			}),
		],
	};

	const response = await complete(model, context, options);

	expect(response.stopReason, response.errorMessage).not.toBe("error");
	expect(response.responseId).toBeTruthy();
	expect(typeof response.responseId).toBe("string");
}

describe("responseId E2E Tests", () => {
	describeIfOpenAI("OpenAI Provider", () => {
		it("should expose responseId", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenAIModel();
			await expectResponseId(model, openaiOptions());
		});
	});

	describeIfAnthropic("Anthropic Provider", () => {
		it("should expose responseId", { retry: 3, timeout: 30000 }, async () => {
			const model = await getAnthropicModel();
			await expectResponseId(model, anthropicOptions());
		});
	});

	describeIfOpenAICodex("OpenAI Codex Provider", () => {
		it("should expose responseId", { retry: 3, timeout: 60_000 }, async () => {
			const model = await getOpenAICodexModel();
			await expectResponseId(model, openaiCodexOptions());
		});
	});

	describeIfOpenRouter("OpenRouter Provider", () => {
		it("should expose responseId", { retry: 3, timeout: 30000 }, async () => {
			const model = await getOpenRouterModel();
			await expectResponseId(model, openrouterOptions());
		});
	});
});
