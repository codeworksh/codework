/** Provider construction and registry integration for the OpenAI Codex provider. */
import { NoSuchModelError } from "@ai-sdk/provider";
import { describe, expect, it } from "vite-plus/test";
import {
	AI_SDK_PACKAGE_TO_PROTOCOL,
	isAISDKPackage,
	loadProviderFactory,
	protocolForPackage,
} from "../../src/llm/registry.ts";
import { createOpenAICodex, OpenAICodexLanguageModel } from "../../src/providers/openai-codex/index.ts";
import { OPENAI_CODEX_TEST_API_KEY } from "../utils/openai-codex.ts";

describe("createOpenAICodex provider", () => {
	it("implements the ProviderV3 specification", () => {
		const provider = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY });
		expect(provider.specificationVersion).toBe("v3");

		const model = provider("gpt-5.4");
		expect(model).toBeInstanceOf(OpenAICodexLanguageModel);
		expect(model.specificationVersion).toBe("v3");
		expect(model.provider).toBe("openai-codex");
		expect(model.modelId).toBe("gpt-5.4");
	});

	it("exposes languageModel and responses methods", () => {
		const provider = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY });
		expect(provider.languageModel("gpt-5.5")).toBeInstanceOf(OpenAICodexLanguageModel);
		expect(provider.responses("gpt-5.5")).toBeInstanceOf(OpenAICodexLanguageModel);
	});

	it("cannot be invoked with the new keyword", () => {
		const provider = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY });
		expect(() => new (provider as unknown as new (modelId: string) => unknown)("gpt-5.4")).toThrow(/new keyword/);
	});

	it("throws NoSuchModelError for non-language models", () => {
		const provider = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY });
		expect(() => provider.embeddingModel("text-embedding-3-small")).toThrow(NoSuchModelError);
		expect(() => provider.imageModel("dall-e-3")).toThrow(NoSuchModelError);
	});

	it("reports no natively supported URLs", () => {
		const model = createOpenAICodex({ apiKey: OPENAI_CODEX_TEST_API_KEY })("gpt-5.4");
		expect(model.supportedUrls).toEqual({});
	});
});

describe("registry integration", () => {
	it("registers @codeworksh/ai-sdk-openai-codex as a known AI SDK package", () => {
		expect(isAISDKPackage("@codeworksh/ai-sdk-openai-codex")).toBe(true);
		expect(AI_SDK_PACKAGE_TO_PROTOCOL["@codeworksh/ai-sdk-openai-codex"]).toBe("openai-codex");
		expect(protocolForPackage("@codeworksh/ai-sdk-openai-codex")).toBe("openai-codex");
	});

	it("loads the createOpenAICodex factory through the provider loader", async () => {
		const factory = await loadProviderFactory("@codeworksh/ai-sdk-openai-codex");
		const provider = factory({ apiKey: OPENAI_CODEX_TEST_API_KEY }) as ReturnType<typeof createOpenAICodex>;
		expect(provider.responses("gpt-5.4")).toBeInstanceOf(OpenAICodexLanguageModel);
	});
});
