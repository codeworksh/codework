import "./utils/env.ts";
import { llm, Model, Message } from "@codeworksh/aikit";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { LLM } from "../src/runner/llm.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { compose } from "../src/settings/resolve.ts";
import { merge } from "../src/settings/merge.ts";
import { defaults } from "../src/settings/schema.ts";

describe("settings at the LLM boundary", () => {
	it("routes provider options under the resolved key and gives runtime maps final precedence", async () => {
		const model = await llm("lmstudio", "qwen/qwen3-coder-30b");
		expect(model).toBeDefined();
		if (!model) return;
		const input: LLM.Input = {
			sessionId: SessionSchema.ID.create(),
			provider: "lmstudio",
			model: model.id,
			resolvedModel: model,
			context: {
				messages: [
					Message.createUserMessage({
						role: "user",
						time: { created: 1 },
						parts: [{ type: "text", text: "hello" }],
					}),
				],
			},
			thinkingLevel: "off",
			settings: {
				thinkingLevel: "off",
				toolExecution: "parallel",
				serviceTier: "auto",
				headers: { a: "file", b: "file" },
				extras: { name: "local" },
			},
			options: {
				headers: { b: "runtime" },
				providerOptions: { "openai-compatible": { serviceTier: "priority", other: true } },
				activeTools: ["bash"],
			},
		};
		const signal = new AbortController().signal;
		const request = LLM.runtimeOptions(input, model, signal);
		expect(request.providerOptions).toEqual({ [Model.optionsKey(model)]: { serviceTier: "priority", other: true } });
		expect(request.headers).toEqual({ a: "file", b: "runtime" });
		expect(request.factoryOptions).toEqual({ name: "local" });
		expect(request.signal).toBe(signal);
		expect(request).not.toHaveProperty("reasoning");
	});

	it("passes matched baseURL, headers, and generation options through the actual transport", async () => {
		let requestedURL = "";
		let requestedHeaders: Headers | undefined;
		let body: Record<string, unknown> = {};
		const fetch = async (url: string | URL | Request, init?: RequestInit) => {
			requestedURL = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
			requestedHeaders = new Headers(init?.headers);
			if (typeof init?.body === "string") body = JSON.parse(init.body);
			const chunk = {
				id: "reply",
				object: "chat.completion.chunk",
				created: 1,
				model: "qwen/qwen3-coder-30b",
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			};
			const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		};
		const selection = compose(
			merge(defaults, {
				model: {
					provider: "lmstudio",
					id: "qwen/qwen3-coder-30b",
					providerOptions: {
						lmstudio: {
							"*": {
								baseURL: "http://settings.test/v1",
								timeoutMs: 5000,
								maxTokens: 17,
								contextWindow: 8192,
								headers: { "x-settings": "yes" },
							},
						},
					},
				},
			}),
		);
		const events = await Effect.runPromise(
			LLM.open(
				{
					sessionId: SessionSchema.ID.create(),
					provider: selection.provider,
					model: selection.model,
					resolvedModel: await Effect.runPromise(
						LLM.resolve({ provider: selection.provider, model: selection.model, settings: selection.block }),
					),
					thinkingLevel: "off",
					context: {
						messages: [
							Message.createUserMessage({
								role: "user",
								time: { created: 1 },
								parts: [{ type: "text", text: "hello" }],
							}),
						],
					},
					settings: selection.block,
					options: { maxRetries: 0, factoryOptions: { fetch } },
				},
				new AbortController().signal,
			),
		);
		const received = [];
		for await (const event of events) received.push(event);
		expect(received.at(-1)?.type, JSON.stringify(received.at(-1))).toBe("done");
		expect(requestedURL).toBe("http://settings.test/v1/chat/completions");
		expect(requestedHeaders?.get("x-settings")).toBe("yes");
		expect(body.max_tokens).toBe(17);
	});

	it("keeps typed lookup errors when settings select a model the catalog does not have", async () => {
		const input = (provider: string, model: string) => ({ provider, model, settings: { contextWindow: 999 } });
		const missing = await Effect.runPromise(LLM.resolve(input("openai", "no-such-model")).pipe(Effect.flip));
		expect(missing._tag).toBe("Runner.ModelNotFoundError");
		expect(missing).toMatchObject({ provider: "openai", model: "no-such-model" });

		const unknownProvider = await Effect.runPromise(
			LLM.resolve(input("no-such-provider", "no-such-model")).pipe(Effect.flip),
		);
		expect(unknownProvider._tag).toBe("Runner.ModelNotFoundError");
	});
});
