import { expect, it } from "vite-plus/test";
import * as Message from "../../src/message/message.ts";
import * as Model from "../../src/model/model.ts";
import { stream } from "../../src/stream.ts";
import {
	describeIfOpenAI,
	describeIfOpenAICodex,
	getOpenAICodexModel,
	getOpenAIModel,
	getText,
	OPENAI_CODEX_E2E_MODELS,
	OPENAI_E2E_MODELS,
	openaiCodexOptions,
	openaiOptions,
	type StreamableModel,
} from "../utils/llm.ts";

/*
 * Every level a caller can request must reach the API as an effort it accepts:
 * supported levels pass through, unsupported ones (e.g. minimal, which every
 * model here rejects) are clamped by the catalog's thinkingLevelMap.
 */
const ACTIVE_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

const WITH_MAX: Model.ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh", "max"];
const WITH_XHIGH: Model.ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"];

// Checked live: the Responses API rejects minimal on all of these and max below gpt-5.6.
const OPENAI_LEVELS: Record<(typeof OPENAI_E2E_MODELS)[number], Model.ThinkingLevel[]> = {
	"gpt-6-luna": WITH_MAX,
	"gpt-5.6-luna": WITH_MAX,
	"gpt-5.5": WITH_XHIGH,
	"gpt-5.4": WITH_XHIGH,
	"gpt-5.4-mini": WITH_XHIGH,
	"gpt-5.4-nano": WITH_XHIGH,
};

// Checked live: Codex accepts the same efforts, "none" included.
const OPENAI_CODEX_LEVELS: Record<(typeof OPENAI_CODEX_E2E_MODELS)[number], Model.ThinkingLevel[]> = {
	"gpt-6-luna": WITH_MAX,
	"gpt-5.6-luna": WITH_MAX,
	"gpt-5.5": WITH_XHIGH,
};

async function expectLevelAccepted(model: StreamableModel, options: object) {
	const a = (Math.random() * 100) | 0;
	const b = (Math.random() * 100) | 0;
	const response = await stream.complete(
		model,
		{
			systemPrompt: "You are a helpful assistant. Be concise.",
			messages: [
				Message.createUserMessage({
					role: "user",
					time: { created: Date.now() },
					parts: [{ type: "text", text: `What is ${a} + ${b}? Reply with the number only.` }],
				}),
			],
		},
		options,
	);

	expect(response.stopReason, response.errorMessage).toBe("stop");
	expect(getText(response)).toContain(String(a + b));
	return response;
}

describeIfOpenAI.each(OPENAI_E2E_MODELS)("OpenAI thinking levels (%s)", (modelId) => {
	it("exposes the levels the API accepts", async () => {
		const model = await getOpenAIModel(modelId);
		expect(Model.getSupportedThinkingLevels(model)).toEqual(OPENAI_LEVELS[modelId]);
		expect(Model.clampThinkingLevel(model, "minimal")).toBe("low");
	});

	it("disables reasoning when no level is requested", { retry: 2, timeout: 60_000 }, async () => {
		const model = await getOpenAIModel(modelId);
		const { reasoning: _, ...off } = openaiOptions();
		const response = await expectLevelAccepted(model, off);
		expect(response.parts.some((part) => part.type === "thinking")).toBe(false);
	});

	it.each(ACTIVE_LEVELS)("accepts reasoning %s", { retry: 2, timeout: 180_000 }, async (reasoning) => {
		const model = await getOpenAIModel(modelId);
		await expectLevelAccepted(model, openaiOptions({ reasoning }));
	});
});

describeIfOpenAICodex.each(OPENAI_CODEX_E2E_MODELS)("OpenAI Codex thinking levels (%s)", (modelId) => {
	it("exposes the levels the API accepts", async () => {
		const model = await getOpenAICodexModel(modelId);
		expect(Model.getSupportedThinkingLevels(model)).toEqual(OPENAI_CODEX_LEVELS[modelId]);
		expect(Model.clampThinkingLevel(model, "minimal")).toBe("low");
	});

	it("disables reasoning when no level is requested", { retry: 2, timeout: 60_000 }, async () => {
		const model = await getOpenAICodexModel(modelId);
		const { reasoning: _, ...off } = openaiCodexOptions();
		const response = await expectLevelAccepted(model, off);
		expect(response.parts.some((part) => part.type === "thinking")).toBe(false);
	});

	it.each(ACTIVE_LEVELS)("accepts reasoning %s", { retry: 2, timeout: 180_000 }, async (reasoning) => {
		const model = await getOpenAICodexModel(modelId);
		await expectLevelAccepted(model, openaiCodexOptions({ reasoning }));
	});
});
