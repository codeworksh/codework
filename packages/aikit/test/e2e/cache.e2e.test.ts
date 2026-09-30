import { randomUUID } from "node:crypto";
import { expect, it } from "vite-plus/test";
import * as Message from "../../src/message/message.ts";
import { stream } from "../../src/stream.ts";
import {
	ANTHROPIC_E2E_MODELS,
	anthropicOptions,
	describeIfAnthropic,
	describeIfOpenAI,
	describeIfOpenAICodex,
	getAnthropicModel,
	getOpenAICodexModel,
	getOpenAIModel,
	getText,
	OPENAI_CODEX_E2E_MODELS,
	OPENAI_E2E_MODELS,
	openaiCodexOptions,
	openaiOptions,
	type StreamableModel,
} from "../utils/llm.ts";

/*
 * sessionId is the cache-affinity key: two requests sharing a long prefix
 * and a session must succeed, and the second must read the cached prefix.
 * The prefix clears every provider's minimum (OpenAI 1024, Claude up to 4096
 * tokens) and carries the session ID so no earlier run has it cached.
 */
async function expectCachedPrefix(model: StreamableModel, options: object) {
	const sessionId = randomUUID();
	const context: Message.Context = {
		systemPrompt: `You are a helpful assistant. Reply exactly as requested. Session ${sessionId}.\n\n${"Reference notes: caching keeps a long, stable prefix warm between turns. ".repeat(500)}`,
		messages: [
			Message.createUserMessage({
				role: "user",
				time: { created: Date.now() },
				parts: [{ type: "text", text: "Reply with exactly: cache affinity e2e success" }],
			}),
		],
	};

	const first = await stream.complete(model, context, { ...options, sessionId });
	expect(first.stopReason, first.errorMessage).toBe("stop");
	expect(getText(first)).toContain("cache affinity e2e success");
	if (model.protocol === "anthropic") expect(first.usage.cacheWrite).toBeGreaterThan(0);

	// Hits are best-effort: a follow-up can land on a cold replica, so allow a few.
	let cacheRead = 0;
	for (let attempt = 0; attempt < 3 && cacheRead === 0; attempt++) {
		const next = await stream.complete(model, context, { ...options, sessionId });
		expect(next.stopReason, next.errorMessage).toBe("stop");
		expect(next.usage.input + next.usage.cacheRead).toBeGreaterThanOrEqual(1024);
		cacheRead = next.usage.cacheRead;
	}
	expect(cacheRead).toBeGreaterThan(0);
}

describeIfOpenAI.each(OPENAI_E2E_MODELS)("OpenAI prompt caching (%s)", (modelId) => {
	it("reads a cached prefix within a session", { retry: 2, timeout: 120_000 }, async () => {
		await expectCachedPrefix(await getOpenAIModel(modelId), openaiOptions());
	});
});

describeIfOpenAICodex.each(OPENAI_CODEX_E2E_MODELS)("OpenAI Codex prompt caching (%s)", (modelId) => {
	it("reads a cached prefix within a session", { retry: 2, timeout: 120_000 }, async () => {
		await expectCachedPrefix(await getOpenAICodexModel(modelId), openaiCodexOptions());
	});
});

// Claude caches only on request; short is the 5-minute TTL, long the 1-hour one.
describeIfAnthropic.each(ANTHROPIC_E2E_MODELS)("Anthropic prompt caching (%s)", (modelId) => {
	it.each(["short", "long"] as const)(
		"writes then reads a cached prefix with %s retention",
		{ retry: 2, timeout: 120_000 },
		async (cacheRetention) => {
			await expectCachedPrefix(await getAnthropicModel(modelId), anthropicOptions({ cacheRetention }));
		},
	);
});
