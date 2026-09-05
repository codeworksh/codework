import { describe, expect, it } from "vite-plus/test";
import { applyDefaultMaxTokens, clampMaxTokensToContext } from "../src/llm/shared.ts";
import type * as Message from "../src/message/message.ts";
import { makeAssistantMessage, makeModel, makeUsage, makeUserMessage } from "./utils/fixtures.ts";

const emptyContext: Message.Context = { messages: [] };

describe("applyDefaultMaxTokens", () => {
	it("keeps an explicit maxTokens from the caller", () => {
		const model = makeModel({ maxTokens: 8192, contextWindow: 200_000 });
		expect(applyDefaultMaxTokens(model, { maxTokens: 1024 }).maxTokens).toBe(1024);
	});

	it("defaults to the model's maxTokens", () => {
		const model = makeModel({ maxTokens: 8192, contextWindow: 200_000 });
		expect(applyDefaultMaxTokens(model).maxTokens).toBe(8192);
	});

	it("keeps the model's maxTokens even when it spans the whole context window", () => {
		// No heuristic cap here: clampMaxTokensToContext knows what the prompt
		// actually costs, so it does the limiting instead of a fixed guess.
		const model = makeModel({ maxTokens: 131_072, contextWindow: 131_072 });
		expect(applyDefaultMaxTokens(model).maxTokens).toBe(131_072);
	});

	it("leaves maxTokens undefined when the model does not declare one", () => {
		const model = makeModel({ maxTokens: 0 });
		expect(applyDefaultMaxTokens(model).maxTokens).toBeUndefined();
	});

	it("preserves the other options", () => {
		const model = makeModel();
		const result = applyDefaultMaxTokens(model, { temperature: 0.5, sessionId: "s1" });
		expect(result.temperature).toBe(0.5);
		expect(result.sessionId).toBe("s1");
	});
});

describe("clampMaxTokensToContext", () => {
	it("leaves a ceiling that fits in the remaining window", () => {
		const model = makeModel({ maxTokens: 8192, contextWindow: 200_000 });
		expect(clampMaxTokensToContext(model, emptyContext, 8192)).toBe(8192);
	});

	it("shrinks a ceiling that would not fit alongside the prompt", () => {
		const model = makeModel({ maxTokens: 131_072, contextWindow: 131_072 });
		// Empty context still reserves the 4096-token safety margin.
		expect(clampMaxTokensToContext(model, emptyContext, 131_072)).toBe(131_072 - 4096);
	});

	it("accounts for the tokens a long conversation already spends", () => {
		const model = makeModel({ maxTokens: 64_000, contextWindow: 100_000 });
		const context: Message.Context = {
			messages: [
				makeUserMessage("hello"),
				makeAssistantMessage(model, { usage: makeUsage({ input: 50_000, output: 5000, totalTokens: 55_000 }) }),
			],
		};
		// 100_000 - 55_000 reported - 4096 safety
		expect(clampMaxTokensToContext(model, context, 64_000)).toBe(100_000 - 55_000 - 4096);
	});

	it("never returns less than one token", () => {
		const model = makeModel({ maxTokens: 8192, contextWindow: 1000 });
		expect(clampMaxTokensToContext(model, emptyContext, 8192)).toBe(1);
	});

	it("passes the ceiling through when the model declares no context window", () => {
		const model = makeModel({ maxTokens: 8192, contextWindow: 0 });
		expect(clampMaxTokensToContext(model, emptyContext, 8192)).toBe(8192);
	});
});
