import { describe, expect, it } from "vite-plus/test";
import type { Message } from "../src/message/message";
import { getOverflowPatterns, isContextOverflow } from "../src/utils/overflow";
import { makeAssistantMessage, makeModel, makeUsage } from "./utils/fixtures";

const model = makeModel();

function errorMessage(text: string): Message.AssistantMessage {
	return makeAssistantMessage(model, { stopReason: "error", errorMessage: text });
}

describe("isContextOverflow", () => {
	describe("provider error messages", () => {
		const overflowErrors: Array<[provider: string, message: string]> = [
			["Anthropic", "prompt is too long: 213462 tokens > 200000 maximum"],
			["Amazon Bedrock", "input is too long for requested model"],
			["OpenAI", "Your input exceeds the context window of this model"],
			["OpenAI-compatible", "This model's maximum context length is 128000 tokens"],
			["Google", "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"],
			["xAI", "This model's maximum prompt length is 131072 but the request contains 537812 tokens"],
			["Groq", "Please reduce the length of the messages or completion"],
			[
				"OpenRouter",
				"This endpoint's maximum context length is 163840 tokens. However, you requested about 217061 tokens",
			],
			["GitHub Copilot", "prompt token count of 9000 exceeds the limit of 8192"],
			["llama.cpp", "the request exceeds the available context size, try increasing it"],
			["LM Studio", "tokens to keep from the initial prompt is greater than the context length"],
			["MiniMax", "invalid params, context window exceeds limit"],
			["Kimi For Coding", "Your request exceeded model token limit: 262144 (requested: 287559)"],
			["generic snake_case", "context_length_exceeded"],
			["generic", "too many tokens"],
			["generic", "token limit exceeded"],
		];

		it.each(overflowErrors)("detects %s overflow errors", (_provider, message) => {
			expect(isContextOverflow(errorMessage(message))).toBe(true);
		});

		it("detects empty-body 400/413 responses (Cerebras, Mistral)", () => {
			expect(isContextOverflow(errorMessage("400 status code (no body)"))).toBe(true);
			expect(isContextOverflow(errorMessage("413 status code (no body)"))).toBe(true);
			expect(isContextOverflow(errorMessage("400 (no body)"))).toBe(true);
		});

		it("does not flag empty-body 429 responses (rate limiting)", () => {
			expect(isContextOverflow(errorMessage("429 status code (no body)"))).toBe(false);
		});

		it("does not flag unrelated errors", () => {
			expect(isContextOverflow(errorMessage("invalid api key"))).toBe(false);
			expect(isContextOverflow(errorMessage("rate limit reached for requests"))).toBe(false);
			expect(isContextOverflow(errorMessage("overloaded_error"))).toBe(false);
		});

		it("requires stopReason error for message-based detection", () => {
			const message = makeAssistantMessage(model, {
				stopReason: "stop",
				errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
			});
			expect(isContextOverflow(message)).toBe(false);
		});
	});

	describe("silent overflow via usage", () => {
		it("detects successful responses whose input exceeds the context window", () => {
			const message = makeAssistantMessage(model, {
				stopReason: "stop",
				usage: makeUsage({ input: 150_000, cacheRead: 60_000 }),
			});
			expect(isContextOverflow(message, 200_000)).toBe(true);
		});

		it("does not flag input within the context window", () => {
			const message = makeAssistantMessage(model, {
				stopReason: "stop",
				usage: makeUsage({ input: 100_000, cacheRead: 50_000 }),
			});
			expect(isContextOverflow(message, 200_000)).toBe(false);
		});

		it("does not check usage when no context window is provided", () => {
			const message = makeAssistantMessage(model, {
				stopReason: "stop",
				usage: makeUsage({ input: 500_000 }),
			});
			expect(isContextOverflow(message)).toBe(false);
		});
	});
});

describe("getOverflowPatterns", () => {
	it("returns a defensive copy", () => {
		const patterns = getOverflowPatterns();
		expect(patterns.length).toBeGreaterThan(0);
		patterns.length = 0;
		expect(getOverflowPatterns().length).toBeGreaterThan(0);
	});
});
