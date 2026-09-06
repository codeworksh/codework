import { expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import Type from "typebox";
import { stream } from "../../src/stream.ts";
import type { GoogleOptions } from "../../src/llm/options.ts";
import type * as Message from "../../src/message/message.ts";
import { estimateContextTokens } from "../../src/utils/estimate.ts";
import { makeUserMessage } from "../utils/fixtures.ts";
import { describeIfGoogle, getGoogleModel, getText, googleOptions } from "../utils/llm.ts";

// The free tier allows five Flash requests per minute. Pace actual HTTP calls,
// including the second request in a tool round trip, rather than retrying 429s.
let lastRequest = 0;
function wireOptions(extras: GoogleOptions = {}) {
	let config: Record<string, unknown> | undefined;
	let failure = "";
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const interval = Number(process.env.GEMINI_E2E_INTERVAL_MS ?? 13_000);
		const wait = Math.max(0, lastRequest + interval - Date.now());
		if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
		lastRequest = Date.now();
		if (typeof init?.body === "string") {
			const body = JSON.parse(init.body) as { generationConfig?: Record<string, unknown> };
			config = body.generationConfig;
		}
		const response = await globalThis.fetch(input, init);
		if (!response.ok) {
			const body = await response.clone().text();
			failure = `${response.status}: ${body.replaceAll(process.env.GEMINI_API_KEY!, "[redacted]")}`;
		}
		return response;
	};
	return {
		options: googleOptions({
			maxTokens: 4_096,
			timeoutMs: 60_000,
			maxRetries: 1,
			...extras,
			factoryOptions: { fetch },
		}),
		config: () => config,
		failure: () => failure,
	};
}

function expectSuccess(message: Message.AssistantMessage, failure: string) {
	expect(message.stopReason, failure || message.errorMessage).toBe("stop");
	expect(message.usage.input + message.usage.cacheRead).toBeGreaterThan(0);
	expect(message.usage.output).toBeGreaterThan(0);
	expect(getText(message)).toContain("42");
}

describeIfGoogle("Gemini real API", () => {
	const models = process.env.GEMINI_E2E_MODELS?.split(",") ?? ["gemini-3.5-flash", "gemini-3.5-flash-lite"];
	for (const id of models) {
		for (const reasoning of [undefined, "minimal", "low", "medium", "high"] as const) {
			it(`${id}: ${reasoning ?? "default"} thinking, streaming and usage`, { timeout: 90_000 }, async () => {
				const model = await getGoogleModel(id);
				const wire = wireOptions(reasoning ? { reasoning } : {});
				const result = stream(
					model,
					{ messages: [makeUserMessage("What is 19 + 23? Reply with just the number.")] },
					wire.options,
				);
				let deltas = "";
				for await (const event of result) if (event.type === "text.delta") deltas += event.delta;
				const message = await result.result();
				expectSuccess(message, wire.failure());
				expect(deltas).toContain("42");
				const config = wire.config();
				if (reasoning) {
					expect(config?.thinkingConfig).toEqual({ thinkingLevel: reasoning, includeThoughts: true });
				} else {
					expect(config?.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
				}
				expect(message.usage.totalTokens).toBe(
					message.usage.input + message.usage.cacheRead + message.usage.cacheWrite + message.usage.output,
				);
			});
		}

		it(
			`${id}: replays thinking and completed tools under a reduced context ceiling`,
			{ timeout: 120_000 },
			async () => {
				const model = await getGoogleModel(id);
				const context: Message.Context = {
					messages: [makeUserMessage("Call lookup to get the secret number, then reply with just that number.")],
					tools: [{ name: "lookup", description: "Get the secret number", parameters: Type.Object({}) }],
				};
				const firstWire = wireOptions({ reasoning: "low", toolChoice: "required" });
				const first = await stream.complete(model, context, firstWire.options);
				expect(first.stopReason, firstWire.failure() || first.errorMessage).toBe("toolUse");
				const call = first.parts.find((part) => part.type === "toolCall");
				expect(call?.type).toBe("toolCall");
				if (!call || call.type !== "toolCall") throw new Error("Expected lookup tool call");
				expect(call.name).toBe("lookup");
				expect(call.thoughtSignature).toBeTruthy();
				context.messages.push(first);
				const before = estimateContextTokens(context).tokens;
				const content = "Secret number: 42.\n" + "Reference padding. ".repeat(2_000);
				first.parts = first.parts.map((part) =>
					part === call
						? {
								...call,
								status: "completed",
								result: { content: [{ type: "text", text: content }], isError: false },
							}
						: part,
				);
				expect(estimateContextTokens(context).tokens - before).toBe(Math.ceil(content.length / 4));
				// Exercise client-side clamping without sending a million-token prompt.
				const constrained = { ...model, contextWindow: estimateContextTokens(context).tokens + 4_096 + 2_048 };
				const secondWire = wireOptions({ reasoning: "low", toolChoice: "none" });
				const second = await stream.complete(constrained, context, secondWire.options);
				expectSuccess(second, secondWire.failure());
				expect(secondWire.config()?.maxOutputTokens).toBe(2_048);
			},
		);

		it(`${id}: accepts image input`, { timeout: 90_000 }, async () => {
			const model = await getGoogleModel(id);
			const user = makeUserMessage("Name the color of the circle in one word.");
			user.parts.push({
				type: "image",
				mimeType: "image/png",
				data: readFileSync(new URL("../data/red-circle.png", import.meta.url)).toString("base64"),
			});
			const wire = wireOptions();
			const response = await stream.complete(model, { messages: [user] }, wire.options);
			expect(response.stopReason, wire.failure() || response.errorMessage).toBe("stop");
			expect(getText(response).toLowerCase()).toContain("red");
		});

		it(`${id}: reports a real output length stop`, { timeout: 90_000 }, async () => {
			const wire = wireOptions({ maxTokens: 64 });
			const response = await stream.complete(
				await getGoogleModel(id),
				{ messages: [makeUserMessage("Write a long essay of at least 1000 words about the ocean.")] },
				wire.options,
			);
			expect(response.stopReason, wire.failure() || response.errorMessage).toBe("length");
			expect(wire.config()?.maxOutputTokens).toBe(64);
			expect(response.usage.output).toBeGreaterThan(0);
		});

		it(`${id}: aborts during a real stream`, { timeout: 90_000 }, async () => {
			const controller = new AbortController();
			const wire = wireOptions({ signal: controller.signal });
			const response = stream(
				await getGoogleModel(id),
				{ messages: [makeUserMessage("Write a long essay of at least 1000 words about the ocean.")] },
				wire.options,
			);
			let received = false;
			for await (const event of response) {
				if (event.type === "text.delta") {
					received = true;
					controller.abort();
				}
			}
			expect(received, wire.failure()).toBe(true);
			expect((await response.result()).stopReason).toBe("aborted");
		});
	}
});
