import { describe, expect, it } from "vite-plus/test";
import {
	adjustMaxTokensForThinking,
	clampThinkingBudgetToAnswerRoom,
	DEFAULT_THINKING_BUDGETS,
	MIN_ANSWER_TOKENS,
	thinkingBudgetForLevel,
} from "../src/llm/shared.ts";

describe("thinkingBudgetForLevel", () => {
	it("uses the default budget for each level", () => {
		expect(thinkingBudgetForLevel("minimal")).toBe(1024);
		expect(thinkingBudgetForLevel("low")).toBe(2048);
		expect(thinkingBudgetForLevel("medium")).toBe(8192);
		expect(thinkingBudgetForLevel("high")).toBe(16384);
	});

	it("falls back to the high budget for xhigh and max", () => {
		expect(thinkingBudgetForLevel("xhigh")).toBe(DEFAULT_THINKING_BUDGETS.high);
		expect(thinkingBudgetForLevel("max")).toBe(DEFAULT_THINKING_BUDGETS.high);
	});

	it("prefers a configured budget for the requested level", () => {
		expect(thinkingBudgetForLevel("medium", { medium: 4096 })).toBe(4096);
		expect(thinkingBudgetForLevel("max", { max: 131_072 })).toBe(131_072);
	});

	it("lets a configured high budget carry xhigh and max", () => {
		expect(thinkingBudgetForLevel("xhigh", { high: 32_768 })).toBe(32_768);
		expect(thinkingBudgetForLevel("max", { high: 32_768 })).toBe(32_768);
	});

	it("keeps defaults for levels the caller did not configure", () => {
		expect(thinkingBudgetForLevel("low", { high: 32_768 })).toBe(2048);
	});
});

describe("clampThinkingBudgetToAnswerRoom", () => {
	it("leaves a budget that fits under the ceiling", () => {
		expect(clampThinkingBudgetToAnswerRoom(4096, 32_000)).toBe(4096);
	});

	it("reserves the answer floor when the budget would fill the ceiling", () => {
		expect(clampThinkingBudgetToAnswerRoom(8192, 8192)).toBe(8192 - MIN_ANSWER_TOKENS);
	});

	it("never returns a negative budget", () => {
		expect(clampThinkingBudgetToAnswerRoom(8192, 512)).toBe(0);
	});
});

describe("adjustMaxTokensForThinking", () => {
	it("uses the model ceiling when the caller sets no cap", () => {
		expect(adjustMaxTokensForThinking(undefined, 64_000, "medium")).toEqual({
			maxTokens: 64_000,
			thinkingBudget: 8192,
		});
	});

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
