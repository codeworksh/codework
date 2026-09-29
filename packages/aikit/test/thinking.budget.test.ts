import { describe, expect, it } from "vite-plus/test";
import {
	adjustMaxTokensForThinking,
	clampThinkingBudgetToAnswerRoom,
	MIN_ANSWER_TOKENS,
	thinkingBudgetForLevel,
} from "../src/llm/shared.ts";

describe("thinkingBudgetForLevel", () => {
	it("lets a configured high budget carry xhigh and max", () => {
		expect(thinkingBudgetForLevel("xhigh", { high: 32_768 })).toBe(32_768);
		expect(thinkingBudgetForLevel("max", { high: 32_768 })).toBe(32_768);
	});
});

describe("clampThinkingBudgetToAnswerRoom", () => {
	it("reserves the answer floor when the budget would fill the ceiling", () => {
		expect(clampThinkingBudgetToAnswerRoom(8192, 8192)).toBe(8192 - MIN_ANSWER_TOKENS);
	});

	it("never returns a negative budget", () => {
		expect(clampThinkingBudgetToAnswerRoom(8192, 512)).toBe(0);
	});
});

describe("adjustMaxTokensForThinking", () => {
	it("adds the budget on top of the caller's answer cap", () => {
		// The caller asked for 16k of answer; thinking gets its own room above it.
		expect(adjustMaxTokensForThinking(16_384, 128_000, "high")).toEqual({
			maxTokens: 32_768,
			thinkingBudget: 16_384,
		});
	});

	it("clamps the combined total to the model ceiling", () => {
		expect(adjustMaxTokensForThinking(16_384, 20_000, "high")).toEqual({
			maxTokens: 20_000,
			thinkingBudget: 16_384,
		});
	});

	it("shrinks the budget rather than the answer when the ceiling is small", () => {
		// A global 32k budget on a small model must not eat the whole response.
		const { maxTokens, thinkingBudget } = adjustMaxTokensForThinking(undefined, 8192, "high", { high: 32_768 });
		expect(maxTokens).toBe(8192);
		expect(thinkingBudget).toBe(8192 - MIN_ANSWER_TOKENS);
		expect(maxTokens - thinkingBudget).toBe(MIN_ANSWER_TOKENS);
	});

	it("leaves no thinking budget when the ceiling is below the answer floor", () => {
		expect(adjustMaxTokensForThinking(undefined, 512, "medium")).toEqual({
			maxTokens: 512,
			thinkingBudget: 0,
		});
	});
});
