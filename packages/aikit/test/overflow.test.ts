import { describe, expect, it } from "vite-plus/test";
import type * as Message from "../src/message/message.ts";
import { getOverflowPatterns, isContextOverflow, isRecoverableLength } from "../src/utils/overflow.ts";
import { makeAssistantMessage, makeModel, makeUsage } from "./utils/fixtures.ts";

const model = makeModel();

function errorMessage(text: string): Message.AssistantMessage {
	return makeAssistantMessage(model, { stopReason: "error", errorMessage: text });
}

function lengthStop(usage: { input: number; cacheRead?: number; output: number }): Message.AssistantMessage {
	return makeAssistantMessage(model, {
		stopReason: "length",
		usage: makeUsage({
			input: usage.input,
			cacheRead: usage.cacheRead ?? 0,
			output: usage.output,
			totalTokens: usage.input + (usage.cacheRead ?? 0) + usage.output,
		}),
	});
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

describe("provider errors that are not overflow", () => {
	it("does not treat Bedrock throttling as overflow", () => {
		// Bedrock words throttling as "Too many tokens", which matches an overflow pattern.
		expect(
			isContextOverflow(errorMessage("Throttling error: Too many tokens, please wait before trying again.")),
		).toBe(false);
	});

	it("does not treat Bedrock service unavailable as overflow", () => {
		expect(isContextOverflow(errorMessage("Service unavailable: too many tokens"))).toBe(false);
	});

	it("does not treat generic rate limits as overflow", () => {
		expect(isContextOverflow(errorMessage("Rate limit exceeded: token limit exceeded for this minute"))).toBe(false);
	});

	it("does not treat HTTP 429 style errors as overflow", () => {
		expect(isContextOverflow(errorMessage("Too Many Requests: too many tokens"))).toBe(false);
	});
});

describe("provider overflow messages", () => {
	const cases: Array<[string, string]> = [
		["Anthropic request byte-size", "request_too_large: request exceeds the maximum allowed size"],
		["Ollama explicit", "prompt too long; exceeded max context length"],
		["Together AI", "Input (300000 tokens) is longer than the model's context length (128000 tokens)"],
		[
			"LiteLLM-wrapped OpenAI",
			"Error: 503 litellm.APIConnectionError: OpenAIException - Requested token count exceeds the model's maximum context length of 131072 tokens.",
		],
		[
			"OpenAI-compatible parenthesized",
			"Error: 400 Input length (265330) exceeds model's maximum context length (262144).",
		],
		[
			"OpenRouter / Poolside",
			"Provider returned error: Input length 131393 exceeds the maximum allowed input length of 131040 tokens.",
		],
		["DS4", "Prompt has 300,000 tokens, but the configured context size is 128,000 tokens"],
		["Mistral", "Prompt is too large for model with 32768 maximum context length"],
		["z.ai finish reason", "model_context_window_exceeded"],
		["DashScope / Qwen", "Range of input length should be [1, 129024]"],
	];

	for (const [name, text] of cases) {
		it(`detects ${name} overflow`, () => {
			expect(isContextOverflow(errorMessage(text))).toBe(true);
		});
	}
});

describe("length-stop overflow", () => {
	it("detects a server that truncated the input to fill the window", () => {
		// Xiaomi MiMo: input trimmed to fit exactly, leaving no room to generate.
		expect(isContextOverflow(lengthStop({ input: 58, cacheRead: 1_048_512, output: 0 }), 1_048_576)).toBe(true);
	});

	it("does not flag a normal length stop that produced output", () => {
		expect(isContextOverflow(lengthStop({ input: 1_000, output: 4_096 }), 200_000)).toBe(false);
	});

	it("does not flag a zero-output length stop far below the window", () => {
		expect(isContextOverflow(lengthStop({ input: 100, output: 0 }), 200_000)).toBe(false);
	});

	it("needs a context window to judge a length stop", () => {
		expect(isContextOverflow(lengthStop({ input: 58, cacheRead: 1_048_512, output: 0 }))).toBe(false);
	});
});

describe("isRecoverableLength", () => {
	it("treats a length stop below the requested limit as recoverable", () => {
		expect(isRecoverableLength(lengthStop({ input: 3, cacheRead: 253_584, output: 16 }), 128_000)).toBe(true);
	});

	it("does not recover a length stop that reached the requested limit", () => {
		expect(isRecoverableLength(lengthStop({ input: 4_062, output: 1_024 }), 1_024)).toBe(false);
	});

	it("recovers a zero-output length stop without needing context metadata", () => {
		expect(isRecoverableLength(lengthStop({ input: 100, output: 0 }), 128_000)).toBe(true);
	});

	it("needs a positive desired limit to judge recoverability", () => {
		expect(isRecoverableLength(lengthStop({ input: 100, output: 0 }), 0)).toBe(false);
	});

	it("ignores messages that did not stop on length", () => {
		expect(isRecoverableLength(errorMessage("boom"), 128_000)).toBe(false);
	});
});
