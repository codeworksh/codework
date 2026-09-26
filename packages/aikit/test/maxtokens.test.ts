import { describe, expect, it } from "vite-plus/test";
import { clampMaxTokensToContext } from "../src/llm/shared.ts";
import type * as Message from "../src/message/message.ts";
import { makeModel } from "./utils/fixtures.ts";

const emptyContext: Message.Context = { messages: [] };

describe("clampMaxTokensToContext", () => {
	it("shrinks a ceiling that would not fit alongside the prompt", () => {
		const model = makeModel({ maxTokens: 131_072, contextWindow: 131_072 });
		// Empty context still reserves the 4096-token safety margin.
		expect(clampMaxTokensToContext(model, emptyContext, 131_072)).toBe(131_072 - 4096);
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
