import { describe, expect, it } from "vite-plus/test";
import { stream } from "../src/llm/stream.ts";
import type { RuntimeOptions } from "../src/llm/options.ts";
import { makeGeneratedModel, makeModel, makeUserMessage } from "./utils/fixtures.ts";

const model = makeModel({ ...makeGeneratedModel("gemini-3.5-flash"), protocol: "google", npm: "@ai-sdk/google" });

// A provider that never answers, so only an abort can end the request.
const hang: typeof globalThis.fetch = (_input, init) =>
	new Promise((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
	});

const run = (options: RuntimeOptions) =>
	stream(
		model,
		{ messages: [makeUserMessage("hello")] },
		{ apiKey: "test-key", maxRetries: 0, factoryOptions: { fetch: hang }, ...options },
	).result();

describe("abort classification", () => {
	it("reports an SDK timeout as a Timeout failure, not a caller abort", async () => {
		const message = await run({ timeoutMs: 20 });
		expect(message.stopReason).toBe("error");
		expect(message.failure).toMatchObject({ _tag: "Timeout", retryable: true });
	});

	it("keeps a caller abort as aborted", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		const message = await run({ signal: controller.signal });
		expect(message.stopReason).toBe("aborted");
		expect(message.failure).toBeUndefined();
	});
});
