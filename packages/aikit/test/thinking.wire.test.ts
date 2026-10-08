import { describe, expect, it } from "vite-plus/test";
import { stream } from "../src/llm/stream.ts";
import type { RuntimeOptions } from "../src/llm/options.ts";
import { makeGeneratedModel, makeModel, makeUserMessage } from "./utils/fixtures.ts";

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
	const message = await stream(
		model,
		{ messages: [makeUserMessage("hello")] },
		{
			...options,
			apiKey: "test-key",
			factoryOptions: { fetch },
		},
	).result();
	expect(body).toBeDefined();
	return { body, message };
}

const captureBody = async (...args: Parameters<typeof capture>) => (await capture(...args)).body;

const google = (overrides: Parameters<typeof makeModel>[0] = {}) =>
	makeModel({
		...makeGeneratedModel(overrides.id ?? "gemini-2.5-pro"),
		protocol: "google",
		npm: "@ai-sdk/google",
		reasoning: true,
		maxTokens: 64_000,
		...overrides,
	});

describe("thinking wire budgets", () => {
	it("adds Google's family budget to the requested answer allowance", async () => {
		expect(await captureBody(google(), { reasoning: "high", maxTokens: 4_096 })).toMatchObject({
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
				await captureBody(google({ contextWindow: 10_000 }), {
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
		expect(await captureBody(google({ maxTokens: 8_192 }), { reasoning: "high" })).toMatchObject({
			generationConfig: { maxOutputTokens: 8_192, thinkingConfig: { thinkingBudget: 7_168 } },
		});
	});

	it("preserves Google's dynamic sentinel without subtracting it from the ceiling", async () => {
		expect(
			await captureBody(google({ id: "gemini-unknown" }), { reasoning: "high", maxTokens: 4_096 }),
		).toMatchObject({
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
		expect(await captureBody(model, { reasoning: "high", maxTokens: 4_096 })).toMatchObject({
			max_tokens: 20_480,
			thinking: { type: "enabled", budget_tokens: 16_384 },
		});
	});
});

type Wire = Record<string, unknown>;
const path = (value: unknown, ...keys: string[]): unknown =>
	keys.reduce<unknown>((at, key) => (typeof at === "object" && at !== null ? (at as Wire)[key] : undefined), value);

const openai = makeModel({ id: "gpt-5.5", protocol: "openai", npm: "@ai-sdk/openai", reasoning: true });
const adaptiveClaude = makeModel({
	id: "claude-opus-5-5",
	npm: "@ai-sdk/anthropic",
	reasoning: true,
	maxTokens: 64_000,
	compat: { forceAdaptiveThinking: true },
});
const budgetClaude = makeModel({
	id: "claude-sonnet-4-5",
	npm: "@ai-sdk/anthropic",
	reasoning: true,
	maxTokens: 64_000,
});
const gemini3 = google({ id: "gemini-3-pro", compat: { supportsThinkingLevel: true } });
const openrouter = makeModel({
	id: "z-ai/glm-5.3-flash",
	protocol: "openrouter",
	npm: "@openrouter/ai-sdk-provider",
	providerOptionsKey: "openrouter",
	reasoning: true,
});

/*
 * `providerThinkingLevel` must be the effort the request carried, so every case
 * reads it back off the captured wire body rather than restating the mapping.
 */
describe("thinking level bookkeeping", () => {
	it.each([
		["OpenAI", openai, ["reasoning", "effort"]],
		["Anthropic adaptive", adaptiveClaude, ["output_config", "effort"]],
		["Gemini 3", gemini3, ["generationConfig", "thinkingConfig", "thinkingLevel"]],
		["OpenRouter", openrouter, ["reasoning", "effort"]],
	] as const)("records the effort %s was sent", async (_name, model, effort) => {
		for (const reasoning of ["minimal", "low", "medium", "high"] as const) {
			const { body, message } = await capture(model, { reasoning });
			expect(message.thinkingLevel).toBe(reasoning);
			expect(message.providerThinkingLevel).toBeDefined();
			expect(message.providerThinkingLevel).toBe(path(body, ...effort));
		}
	});

	it("records the requested level beside the clamped effort", async () => {
		const { body, message } = await capture(adaptiveClaude, { reasoning: "minimal" });
		expect(path(body, "output_config", "effort")).toBe("low");
		expect(message).toMatchObject({ thinkingLevel: "minimal", providerThinkingLevel: "low" });
	});

	it("records off, and the provider's own off, when no level is requested", async () => {
		const { body, message } = await capture(openai, {});
		expect(path(body, "reasoning", "effort")).toBe("none");
		expect(message).toMatchObject({ thinkingLevel: "off", providerThinkingLevel: "none" });
	});

	it.each([
		["a token budget", budgetClaude, { reasoning: "high" }],
		["disabled thinking", adaptiveClaude, {}],
		["OpenRouter's pass-through off", openrouter, {}],
	] as const)("records no native level for %s", async (_name, model, options) => {
		const { body, message } = await capture(model, options);
		expect(path(body, "output_config", "effort") ?? path(body, "reasoning", "effort")).toBeUndefined();
		expect(message.providerThinkingLevel).toBeUndefined();
		expect(message.thinkingLevel).toBe("reasoning" in options ? options.reasoning : "off");
	});

	it.each([
		["an OpenAI effort", openai, { openai: { reasoningEffort: "low" } }, ["reasoning", "effort"], "low"],
		[
			"an effort on a budgeted Claude",
			budgetClaude,
			{ anthropic: { effort: "max" } },
			["output_config", "effort"],
			"max",
		],
	] as const)("records %s override as what was sent", async (_name, model, providerOptions, effort, sent) => {
		const { body, message } = await capture(model, { reasoning: "high", providerOptions });
		expect(path(body, ...effort)).toBe(sent);
		expect(message).toMatchObject({ thinkingLevel: "high", providerThinkingLevel: sent });
	});

	it("records nothing when the adapter drops the effort for a model it does not know", async () => {
		const unknown = makeModel({ id: "custom-reasoner", protocol: "openai", npm: "@ai-sdk/openai", reasoning: true });
		const { body, message } = await capture(unknown, { reasoning: "high" });
		expect(path(body, "reasoning")).toBeUndefined();
		expect(message).toMatchObject({ thinkingLevel: "high" });
		expect(message.providerThinkingLevel).toBeUndefined();
	});

	it("records no native level when thinking is disabled, whatever effort the adapter sends", async () => {
		const { body, message } = await capture(adaptiveClaude, { providerOptions: { anthropic: { effort: "max" } } });
		expect(path(body, "thinking", "type")).toBe("disabled");
		expect(message.providerThinkingLevel).toBeUndefined();
	});
});
