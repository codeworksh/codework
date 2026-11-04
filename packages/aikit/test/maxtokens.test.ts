import { describe, expect, it } from "vite-plus/test";
import { clampMaxTokensToContext } from "../src/llm/shared.ts";
import * as Message from "../src/message/message.ts";
import { makeModel, makeUsage } from "./utils/fixtures.ts";

const emptyContext: Message.Context = { messages: [] };
const WINDOW = 1_048_576;

// The last assistant usage anchors the estimate, so the estimated input is exactly `inputTokens`.
function contextWithInput(inputTokens: number): Message.Context {
	const model = makeModel();
	return {
		messages: [
			Message.createUserMessage({ role: "user", parts: [{ type: "text", text: "hi" }], time: { created: 1 } }),
			Message.createAssistantMessage({
				role: "assistant",
				parts: [{ type: "text", text: "ok" }],
				protocol: model.protocol,
				provider: model.provider,
				model: model.id,
				thinkingLevel: "off",
				usage: makeUsage({ input: inputTokens, totalTokens: inputTokens }),
				stopReason: "stop",
				time: { created: 2, completed: 2 },
			}),
		],
	};
}

describe("clampMaxTokensToContext", () => {
	it("shrinks a ceiling that would not fit alongside the prompt", () => {
		const model = makeModel({ maxTokens: 131_072, contextWindow: 131_072 });
		// Empty context still reserves the 4096-token safety margin.
		expect(clampMaxTokensToContext(model, emptyContext, 131_072)).toBe(131_072 - 4096);
	});

	it("never returns less than the smallest ceiling providers accept", () => {
		const model = makeModel({ maxTokens: 8192, contextWindow: 1000 });
		expect(clampMaxTokensToContext(model, emptyContext, 8192)).toBe(16);
	});

	it("passes the ceiling through when the model declares no context window", () => {
		const model = makeModel({ maxTokens: 8192, contextWindow: 0 });
		expect(clampMaxTokensToContext(model, emptyContext, 8192)).toBe(8192);
	});

	it("leaves 15% of the input unused so an OpenRouter overcount still fits", () => {
		// The failing request: OpenRouter counted 105,153 input tokens where aikit estimated 100,762.
		const model = makeModel({ maxTokens: WINDOW, contextWindow: WINDOW });
		const maxTokens = clampMaxTokensToContext(model, contextWithInput(100_762), WINDOW);
		expect(maxTokens).toBe(WINDOW - 100_762 - 15_115);
		expect(105_153 + maxTokens).toBeLessThanOrEqual(WINDOW);
	});

	it("leaves at least 4096 tokens unused for small inputs", () => {
		const model = makeModel({ maxTokens: WINDOW, contextWindow: WINDOW });
		expect(clampMaxTokensToContext(model, contextWithInput(10_000), WINDOW)).toBe(WINDOW - 10_000 - 4096);
	});

	it("keeps the model output limit when it already fits", () => {
		const model = makeModel({ maxTokens: 64_000, contextWindow: WINDOW });
		expect(clampMaxTokensToContext(model, contextWithInput(100_000), 64_000)).toBe(64_000);
	});

	it("sends up to 32768 tokens when the proportional margin leaves no room", () => {
		const model = makeModel({ maxTokens: WINDOW, contextWindow: WINDOW });
		expect(clampMaxTokensToContext(model, contextWithInput(912_000), WINDOW)).toBe(32_768);
	});

	it("uses the real room minus 4096 when less than 32768 tokens fit", () => {
		const model = makeModel({ maxTokens: WINDOW, contextWindow: WINDOW });
		expect(clampMaxTokensToContext(model, contextWithInput(1_030_000), WINDOW)).toBe(WINDOW - 1_030_000 - 4096);
	});

	it("keeps only the fixed 4096 margin for small windows", () => {
		const model = makeModel({ maxTokens: 32_768, contextWindow: 32_768 });
		expect(clampMaxTokensToContext(model, contextWithInput(20_000), 32_768)).toBe(32_768 - 20_000 - 4096);
	});
});
