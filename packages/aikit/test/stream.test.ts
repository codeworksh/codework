import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { llm } from "../src/llm";
import { Message } from "../src/message/message";
import { ModelCatalog } from "../src/model/catalog";
import { Model } from "../src/model/model";
import { Provider } from "../src/provider/provider";
import { Stream } from "../src/provider/stream";
import { complete, completeSimple, stream, streamSimple } from "../src/stream";
import "./utils/env";
import { ROOT_MODELS_PATH } from "./utils/paths";

function contextFor(prompt: string): Message.Context {
	return {
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
						text: prompt,
					},
				],
			}),
		],
	};
}

function getText(message: Message.AssistantMessage): string {
	return message.parts
		.filter((part): part is Message.TextContent => part.type === "text")
		.map((part) => part.text)
		.join("");
}

async function getAnthropicModel() {
	const model = await llm("anthropic", "claude-haiku-4-5-20251001");
	expect(model).toBeDefined();
	return model!;
}

function createOpenAICompletionsModel(): Model.TModel<typeof Model.KnownProtocolEnum.openaiCompletions> {
	return {
		id: "gpt-4o-mini",
		name: "gpt-4o-mini",
		provider: {
			id: Provider.KnownProviderEnum.openai,
			name: "OpenAI",
			env: ["OPENAI_API_KEY"],
		},
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 128000,
		maxTokens: 16384,
		protocol: Model.KnownProtocolEnum.openaiCompletions,
	};
}

describe("stream", () => {
	it("registers built-in protocol providers into the Stream registry", () => {
		const anthropicProvider = Stream.getProtocolProvider(Model.KnownProtocolEnum.anthropicMessages);
		const openAICompletionsProvider = Stream.getProtocolProvider(Model.KnownProtocolEnum.openaiCompletions);
		const registeredProtocols = Stream.getApiProviders()
			.map((entry) => entry.protocol)
			.sort();

		expect(anthropicProvider).toBeDefined();
		expect(anthropicProvider?.protocol).toBe(Model.KnownProtocolEnum.anthropicMessages);
		expect(openAICompletionsProvider).toBeDefined();
		expect(openAICompletionsProvider?.protocol).toBe(Model.KnownProtocolEnum.openaiCompletions);
		expect(registeredProtocols).toEqual([
			Model.KnownProtocolEnum.anthropicMessages,
			Model.KnownProtocolEnum.openaiCompletions,
		]);
	});

	it("exposes the public callable helpers from the facade module", () => {
		expect(stream.complete).toBe(complete);
		expect(stream.simple).toBe(streamSimple);
		expect(stream.completeSimple).toBe(completeSimple);
		expect(stream.resolveProtocolProvider).toBe(Stream.resolveProtocolProvider);
	});

	it("throws a named error when a protocol provider is not registered", () => {
		const registeredProviders = Stream.getApiProviders();

		try {
			Stream.clearProtocolProviders();
			stream.resolveProtocolProvider({
				protocol: Model.KnownProtocolEnum.anthropicMessages,
			} as unknown as Model.Info);
			throw new Error("expected resolveProtocolProvider() to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(Stream.ProtocolProviderNotFoundError);
			expect((error as Stream.ProtocolProviderNotFoundError).data.protocol).toBe(
				Model.KnownProtocolEnum.anthropicMessages,
			);
		} finally {
			for (const provider of registeredProviders) {
				Stream.registerProtocolProvider(provider, `test-restore-${provider.protocol}`);
			}
		}
	});
});

const describeIfAnthropic = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;
const describeIfOpenAI = process.env.OPENAI_API_KEY ? describe : describe.skip;

describeIfAnthropic("anthropic stream", () => {
	const originalModelsPath = process.env.CODEWORK_AIKIT_MODELS_PATH;

	beforeEach(() => {
		process.env.CODEWORK_AIKIT_MODELS_PATH = ROOT_MODELS_PATH;
		ModelCatalog.modelsDevData.reset();
		Model.registry.reset();
	});

	afterEach(() => {
		process.env.CODEWORK_AIKIT_MODELS_PATH = originalModelsPath;
		ModelCatalog.modelsDevData.reset();
		Model.registry.reset();
	});

	it("completes basic text generation", async () => {
		const model = await getAnthropicModel();
		const response = await stream.complete(model, contextFor("Reply with exactly: Hello test successful"), {
			apiKey: process.env.ANTHROPIC_API_KEY,
		});

		expect(response.role).toBe("assistant");
		expect(response.provider.id).toBe("anthropic");
		expect(response.model).toBe(model.id);
		expect(response.usage.input + response.usage.cacheRead).toBeGreaterThan(0);
		expect(response.usage.output).toBeGreaterThan(0);
		expect(response.errorMessage).toBeFalsy();
		expect(getText(response)).toContain("Hello test successful");
	}, 30000);

	it("streams text events", async () => {
		const model = await getAnthropicModel();
		const s = stream(model, contextFor("Count from 1 to 3 in plain text"), {
			apiKey: process.env.ANTHROPIC_API_KEY,
		});

		let textStarted = false;
		let textChunks = "";
		let textCompleted = false;

		for await (const event of s) {
			if (event.type === "text.start") {
				textStarted = true;
			} else if (event.type === "text.delta") {
				textChunks += event.delta;
			} else if (event.type === "text.end") {
				textCompleted = true;
			}
		}

		const response = await s.result();

		expect(textStarted).toBe(true);
		expect(textChunks.length).toBeGreaterThan(0);
		expect(textCompleted).toBe(true);
		expect(response.role).toBe("assistant");
		expect(response.errorMessage).toBeFalsy();
		expect(getText(response).length).toBeGreaterThan(0);
	}, 30000);
});

describeIfOpenAI("openai completions stream", () => {
	it("completes basic text generation", async () => {
		const model = createOpenAICompletionsModel();
		const response = await stream.complete(
			model,
			contextFor("Reply with exactly: OpenAI registered test successful"),
			{
				apiKey: process.env.OPENAI_API_KEY,
			},
		);

		expect(response.role).toBe("assistant");
		expect(response.provider.id).toBe("openai");
		expect(response.model).toBe(model.id);
		expect(response.usage.input + response.usage.cacheRead).toBeGreaterThan(0);
		expect(response.usage.output).toBeGreaterThan(0);
		expect(response.errorMessage).toBeFalsy();
		expect(getText(response)).toContain("OpenAI registered test successful");
	}, 30000);

	it("streams text events", async () => {
		const model = createOpenAICompletionsModel();
		const s = stream(model, contextFor("Count from 1 to 3 in plain text"), {
			apiKey: process.env.OPENAI_API_KEY,
		});

		let textStarted = false;
		let textChunks = "";
		let textCompleted = false;

		for await (const event of s) {
			if (event.type === "text.start") {
				textStarted = true;
			} else if (event.type === "text.delta") {
				textChunks += event.delta;
			} else if (event.type === "text.end") {
				textCompleted = true;
			}
		}

		const response = await s.result();

		expect(textStarted).toBe(true);
		expect(textChunks.length).toBeGreaterThan(0);
		expect(textCompleted).toBe(true);
		expect(response.role).toBe("assistant");
		expect(response.errorMessage).toBeFalsy();
		expect(getText(response).length).toBeGreaterThan(0);
	}, 30000);
});
