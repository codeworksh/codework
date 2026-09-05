import { describe, expect, it } from "vite-plus/test";
import { stream } from "../src/llm/stream.ts";
import type { RuntimeOptions } from "../src/llm/options.ts";
import { makeModel, makeUserMessage } from "./utils/fixtures.ts";

async function capture(model: ReturnType<typeof makeModel>, options: RuntimeOptions) {
	let body: unknown;
	const fetch: typeof globalThis.fetch = async (_input, init) => {
		if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
		body = JSON.parse(init.body);
		return new Response(JSON.stringify({ error: { message: "Captured request", type: "invalid_request_error" } }), {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	};
	await stream(
		model,
		{ messages: [makeUserMessage("hello")] },
		{
			...options,
			apiKey: "test-key",
			factoryOptions: { fetch },
		},
	).result();
	expect(body).toBeDefined();
	return body;
}

const google = (overrides: Parameters<typeof makeModel>[0] = {}) =>
	makeModel({
		id: "gemini-2.5-pro",
		protocol: "google",
		npm: "@ai-sdk/google",
		reasoning: true,
		maxTokens: 64_000,
		...overrides,
	});

describe("thinking wire budgets", () => {
	it("adds Google's family budget to the requested answer allowance", async () => {
		expect(await capture(google(), { reasoning: "high", maxTokens: 4_096 })).toMatchObject({
			generationConfig: {
				maxOutputTokens: 36_864,
				thinkingConfig: { thinkingBudget: 32_768, includeThoughts: true },
			},
		});
	});

	it.each([undefined, { high: 32_768 }])(
		"keeps Google's fitted budget under context pressure (%j)",
		async (thinkingBudgets) => {
			// hello = 2 estimated tokens; 10,000 - 2 - 4,096 = 5,902.
			expect(
				await capture(google({ contextWindow: 10_000 }), {
					reasoning: "high",
					maxTokens: 4_096,
					...(thinkingBudgets ? { thinkingBudgets } : {}),
				}),
			).toMatchObject({
				generationConfig: {
					maxOutputTokens: 5_902,
					thinkingConfig: { thinkingBudget: 4_878 },
				},
			});
		},
	);

	it("fits Google's budget under the model ceiling", async () => {
		expect(await capture(google({ maxTokens: 8_192 }), { reasoning: "high" })).toMatchObject({
			generationConfig: { maxOutputTokens: 8_192, thinkingConfig: { thinkingBudget: 7_168 } },
		});
	});

	it("preserves Google's dynamic sentinel without subtracting it from the ceiling", async () => {
		expect(await capture(google({ id: "gemini-unknown" }), { reasoning: "high", maxTokens: 4_096 })).toMatchObject({
			generationConfig: { maxOutputTokens: 4_096, thinkingConfig: { thinkingBudget: -1 } },
		});
	});

	it("lets the Anthropic adapter add the budget exactly once", async () => {
		const model = makeModel({
			id: "claude-sonnet-4-5",
			npm: "@ai-sdk/anthropic",
			reasoning: true,
			maxTokens: 64_000,
		});
		expect(await capture(model, { reasoning: "high", maxTokens: 4_096 })).toMatchObject({
			max_tokens: 20_480,
			thinking: { type: "enabled", budget_tokens: 16_384 },
		});
	});
});
