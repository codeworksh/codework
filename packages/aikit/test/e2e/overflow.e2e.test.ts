import { expect, it } from "vite-plus/test";
import * as Message from "../../src/message/message.ts";
import { stream } from "../../src/stream.ts";
import { isContextOverflow } from "../../src/utils/overflow.ts";
import {
	ANTHROPIC_E2E_MODELS,
	anthropicOptions,
	describeIfAnthropic,
	describeIfOpenAI,
	describeIfOpenAICodex,
	getAnthropicModel,
	getOpenAICodexModel,
	getOpenAIModel,
	OPENAI_CODEX_E2E_MODELS,
	OPENAI_E2E_MODELS,
	openaiCodexOptions,
	openaiOptions,
	type StreamableModel,
	OPENROUTER_E2E_MODELS,
	describeIfOpenRouter,
	getOpenRouterModel,
	openrouterOptions,
} from "../utils/llm.ts";

const LOREM_IPSUM =
	"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. ";

// The Responses API's hard input limit. Codex catalogs a smaller window on
// purpose: input above 272k tokens is billed at long-context rates, yet the
// server accepts up to this limit, so the test has to clear the hard limit.
const OPENAI_HARD_CONTEXT = 1_050_000;

/*
 * Input well past the context window: the provider must reject it, and the
 * terminal message must carry an error that isContextOverflow recognises so
 * callers can compact and retry.
 */
async function expectContextOverflow(model: StreamableModel, options: object, name: string, hardContext = 0) {
	const targetChars = (Math.max(model.contextWindow, hardContext) + 10_000) * 4 * 1.5;
	const response = await stream.complete(
		model,
		{
			systemPrompt: "You are a helpful assistant.",
			messages: [
				Message.createUserMessage({
					role: "user",
					time: { created: Date.now() },
					parts: [{ type: "text", text: LOREM_IPSUM.repeat(Math.ceil(targetChars / LOREM_IPSUM.length)) }],
				}),
			],
		},
		options,
	);

	expect(response.stopReason).toBe("error");
	expect(isContextOverflow(response, model.contextWindow), response.errorMessage).toBe(true);
	await expect(
		JSON.stringify(
			{
				stopReason: response.stopReason,
				failure: { _tag: response.failure?._tag, retryable: response.failure?.retryable },
				overflow: isContextOverflow(response, model.contextWindow),
			},
			null,
			"\t",
		),
	).toMatchFileSnapshot(`./__artifacts__/overflow.${name}.json`);
}

describeIfOpenAI.each(OPENAI_E2E_MODELS)("OpenAI context overflow (%s)", (modelId) => {
	it("reports a recognisable context overflow", { retry: 2, timeout: 180_000 }, async () => {
		const model = await getOpenAIModel(modelId);
		await expectContextOverflow(model, openaiOptions(), "openai", OPENAI_HARD_CONTEXT);
	});
});

describeIfOpenAICodex.each(OPENAI_CODEX_E2E_MODELS)("OpenAI Codex context overflow (%s)", (modelId) => {
	it("reports a recognisable context overflow", { retry: 2, timeout: 180_000 }, async () => {
		const model = await getOpenAICodexModel(modelId);
		await expectContextOverflow(model, openaiCodexOptions(), "openai-codex", OPENAI_HARD_CONTEXT);
	});
});

describeIfAnthropic.each(ANTHROPIC_E2E_MODELS)("Anthropic context overflow (%s)", (modelId) => {
	it("reports a recognisable context overflow", { retry: 2, timeout: 180_000 }, async () => {
		const model = await getAnthropicModel(modelId);
		await expectContextOverflow(model, anthropicOptions(), "anthropic");
	});
});

describeIfOpenRouter.each(OPENROUTER_E2E_MODELS)("OpenRouter context overflow (%s)", (modelId) => {
	it("reports a recognisable context overflow", { retry: 2, timeout: 180_000 }, async () => {
		const model = await getOpenRouterModel(modelId);
		await expectContextOverflow(model, openrouterOptions(), "openrouter");
	});
});
