import { describe, expect, it } from "vite-plus/test";
import { thinkingTokenBudgetTransform } from "../src/llm/provider.ts";
import * as Model from "../src/model/model.ts";
import { makeModel } from "./utils/fixtures.ts";

const compatible = (compat?: Model.Compatibility) =>
	makeModel({
		id: "qwen/qwen3-coder-30b",
		protocol: "openai-compatible",
		providerOptionsKey: "openai-compatible",
		npm: "@ai-sdk/openai-compatible",
		baseUrl: "http://localhost:1234/v1",
		reasoning: true,
		...(compat === undefined ? {} : { compat }),
	});

describe("Model.thinkingTokenBudgetField", () => {
	it("is absent unless the model declares support", () => {
		expect(Model.thinkingTokenBudgetField(compatible())).toBeUndefined();
		expect(Model.thinkingTokenBudgetField(compatible({ supportsToolSearch: true }))).toBeUndefined();
	});

	it("defaults to the conventional field name", () => {
		expect(Model.thinkingTokenBudgetField(compatible({ supportsThinkingTokenBudget: true }))).toBe(
			"thinking_token_budget",
		);
	});

	it("prefers an endpoint's own field name", () => {
		expect(Model.thinkingTokenBudgetField(compatible({ thinkingTokenBudgetField: "reasoning_max_tokens" }))).toBe(
			"reasoning_max_tokens",
		);
	});
});

describe("thinkingTokenBudgetTransform", () => {
	it("adds the budget under the declared field", () => {
		const transform = thinkingTokenBudgetTransform("thinking_token_budget", 4096, undefined);
		expect(transform({ model: "qwen", stream: true })).toEqual({
			model: "qwen",
			stream: true,
			thinking_token_budget: 4096,
		});
	});

	it("uses an endpoint's own field name", () => {
		const transform = thinkingTokenBudgetTransform("reasoning_max_tokens", 2048, undefined);
		expect(transform({}).reasoning_max_tokens).toBe(2048);
	});

	it("runs after a transform the caller already installed", () => {
		const existing = (body: Record<string, unknown>) => ({ ...body, injected: true });
		const transform = thinkingTokenBudgetTransform("thinking_token_budget", 1024, existing);
		expect(transform({ model: "qwen" })).toEqual({
			model: "qwen",
			injected: true,
			thinking_token_budget: 1024,
		});
	});

	it("ignores a non-callable transform on the factory options", () => {
		const transform = thinkingTokenBudgetTransform("thinking_token_budget", 512, "not a function");
		expect(transform({ model: "qwen" })).toEqual({ model: "qwen", thinking_token_budget: 512 });
	});
});
