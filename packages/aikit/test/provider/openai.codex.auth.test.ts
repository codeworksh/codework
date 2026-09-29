/** Authentication and OAuth credential lookup for the OpenAI Codex provider. */
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createOpenAICodex } from "../../src/providers/openai-codex/index.ts";
import {
	createOpenAICodexMockFetch,
	openAICodexSSEResponse,
	openAICodexTextEvents,
	openAICodexUserPrompt,
} from "../utils/openai-codex.ts";

let savedEnvKey: string | undefined;

beforeEach(() => {
	savedEnvKey = process.env.OPENAI_CODEX_API_KEY;
	delete process.env.OPENAI_CODEX_API_KEY;
});

afterEach(() => {
	if (savedEnvKey === undefined) delete process.env.OPENAI_CODEX_API_KEY;
	else process.env.OPENAI_CODEX_API_KEY = savedEnvKey;
});

describe("authentication", () => {
	it("fails when the account id cannot be extracted from the token", async () => {
		const { fetch } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		const model = createOpenAICodex({ apiKey: "not-a-jwt", fetch })("gpt-5.4");
		await expect(model.doStream({ prompt: openAICodexUserPrompt })).rejects.toThrow(/account id/);
	});

	it("accepts an explicit accountId for opaque tokens", async () => {
		const { fetch, calls } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		const model = createOpenAICodex({ apiKey: "opaque-token", accountId: "acct_explicit", fetch })("gpt-5.4");
		await model.doStream({ prompt: openAICodexUserPrompt });

		expect(calls[0]?.init.headers["chatgpt-account-id"]).toBe("acct_explicit");
	});
});
