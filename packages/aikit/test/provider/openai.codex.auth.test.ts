/** Authentication and OAuth credential lookup for the OpenAI Codex provider. */
import { LoadAPIKeyError } from "@ai-sdk/provider";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { getOpenAICodexApiKey, type OpenAICodexOAuthCredentials } from "../../src/oauth/openai/codex.ts";
import { createOpenAICodex } from "../../src/providers/openai-codex/index.ts";
import {
	createOpenAICodexMockFetch,
	OPENAI_CODEX_TEST_ACCOUNT_ID,
	OPENAI_CODEX_TEST_API_KEY,
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
	it("fails with LoadAPIKeyError when no API key is available", async () => {
		const { fetch } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		const model = createOpenAICodex({ fetch })("gpt-5.4");
		await expect(model.doStream({ prompt: openAICodexUserPrompt })).rejects.toThrow(LoadAPIKeyError);
	});

	it("reads the API key from OPENAI_CODEX_API_KEY", async () => {
		process.env.OPENAI_CODEX_API_KEY = OPENAI_CODEX_TEST_API_KEY;
		const { fetch, calls } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		const model = createOpenAICodex({ fetch })("gpt-5.4");
		await model.doStream({ prompt: openAICodexUserPrompt });

		expect(calls[0]?.init.headers.Authorization).toBe(`Bearer ${OPENAI_CODEX_TEST_API_KEY}`);
	});

	it("supports an async apiKey resolver", async () => {
		const { fetch, calls } = createOpenAICodexMockFetch(openAICodexSSEResponse(openAICodexTextEvents));
		const model = createOpenAICodex({ apiKey: async () => OPENAI_CODEX_TEST_API_KEY, fetch })("gpt-5.4");
		await model.doStream({ prompt: openAICodexUserPrompt });

		expect(calls[0]?.init.headers.Authorization).toBe(`Bearer ${OPENAI_CODEX_TEST_API_KEY}`);
	});

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

describe("getOpenAICodexApiKey", () => {
	function makeCredentials(): OpenAICodexOAuthCredentials {
		return {
			access: OPENAI_CODEX_TEST_API_KEY,
			refresh: "refresh-token",
			expires: Date.now() + 60 * 60 * 1000,
			accountId: OPENAI_CODEX_TEST_ACCOUNT_ID,
		};
	}

	it("prefers the OPENAI_CODEX_API_KEY environment variable", async () => {
		process.env.OPENAI_CODEX_API_KEY = "env-key";
		await expect(getOpenAICodexApiKey()).resolves.toBe("env-key");
	});

	it("falls back to stored OAuth credentials", async () => {
		const credentials = makeCredentials();
		const storage = {
			get: async () => credentials,
			set: async () => {},
			clear: async () => {},
		};
		await expect(getOpenAICodexApiKey({ storage })).resolves.toBe(OPENAI_CODEX_TEST_API_KEY);
	});

	it("resolves undefined when no key source is available", async () => {
		const storage = {
			get: async () => undefined,
			set: async () => {},
			clear: async () => {},
		};
		await expect(getOpenAICodexApiKey({ storage })).resolves.toBeUndefined();
	});
});
