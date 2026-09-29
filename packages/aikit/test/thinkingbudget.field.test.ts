import { describe, expect, it } from "vite-plus/test";
import { thinkingTokenBudgetTransform } from "../src/llm/provider.ts";

describe("thinkingTokenBudgetTransform", () => {
	it("runs after a transform the caller already installed", () => {
		const existing = (body: Record<string, unknown>) => ({ ...body, injected: true });
		const transform = thinkingTokenBudgetTransform("thinking_token_budget", 1024, existing);
		expect(transform({ model: "qwen" })).toEqual({
			model: "qwen",
			injected: true,
			thinking_token_budget: 1024,
		});
	});
});
