import { describe, expect, it } from "vite-plus/test";
import { applyDefaultMaxTokens } from "../src/llm/shared";
import { makeModel } from "./utils/fixtures";

describe("applyDefaultMaxTokens", () => {
	it("keeps an explicit maxTokens from the caller", () => {
		const model = makeModel({ maxTokens: 8192, contextWindow: 200_000 });
		expect(applyDefaultMaxTokens(model, { maxTokens: 1024 }).maxTokens).toBe(1024);
	});

	it("defaults to the model's maxTokens when it leaves room for input", () => {
		const model = makeModel({ maxTokens: 8192, contextWindow: 200_000 });
		expect(applyDefaultMaxTokens(model).maxTokens).toBe(8192);
	});

	it("caps the default when maxTokens spans the whole context window", () => {
		// Some catalogs report maxTokens == contextWindow; defaulting to that
		// would leave no room for input, so the default is capped at 32k.
		const model = makeModel({ maxTokens: 131_072, contextWindow: 131_072 });
		expect(applyDefaultMaxTokens(model).maxTokens).toBe(32_000);
	});

	it("keeps small maxTokens even when it equals the context window", () => {
		const model = makeModel({ maxTokens: 4096, contextWindow: 4096 });
		expect(applyDefaultMaxTokens(model).maxTokens).toBe(4096);
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
