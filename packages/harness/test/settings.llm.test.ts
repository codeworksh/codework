import "./utils/env.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { llm, Model, Message } from "@codeworksh/aikit";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { LLM } from "../src/runner/llm.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { compose } from "../src/settings/resolve.ts";
import { merge } from "../src/settings/merge.ts";
import { defaults } from "../src/settings/schema.ts";

describe("settings at the LLM boundary", () => {
	it("uses stored OpenAI Codex OAuth credentials from the harness auth file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "codework-harness-oauth-"));
		const authFile = join(directory, "auth.json");
		const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
		const access = `${encode({ alg: "none", typ: "JWT" })}.${encode({
			"https://api.openai.com/auth": { chatgpt_account_id: "acct_harness" },
		})}.signature`;
		const previous = process.env.OPENAI_CODEX_API_KEY;
		Reflect.deleteProperty(process.env, "OPENAI_CODEX_API_KEY");

		try {
			await writeFile(
				authFile,
				JSON.stringify({
					"openai-codex": {
						access,
						refresh: "refresh-token",
						expires: Date.now() + 60 * 60 * 1_000,
						accountId: "acct_harness",
					},
				}),
			);
			let authorization: string | null = null;
			const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
				authorization = new Headers(init?.headers).get("authorization");
				const events = [
					{ type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
					{
						type: "response.output_item.added",
						item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
					},
					{
						type: "response.output_item.done",
						item: {
							type: "message",
							id: "msg_1",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "ok", annotations: [] }],
						},
					},
					{
						type: "response.completed",
						response: {
							id: "resp_1",
							model: "gpt-5.4",
							status: "completed",
							usage: {
								input_tokens: 1,
								output_tokens: 1,
								total_tokens: 2,
								input_tokens_details: { cached_tokens: 0 },
								output_tokens_details: { reasoning_tokens: 0 },
							},
						},
					},
				];
				return new Response(
					`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
					{
						headers: { "content-type": "text/event-stream" },
					},
				);
			};
			const model = await llm("openai-codex", "gpt-5.4");
			expect(model).toBeDefined();
			if (!model) return;

			const events = await Effect.runPromise(
				LLM.openWith({ authFile })(
					{
						sessionId: SessionSchema.ID.create(),
						provider: "openai-codex",
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
						options: { maxRetries: 0, factoryOptions: { fetch } },
					},
					new AbortController().signal,
				),
			);
			for await (const _event of events) {
				// Drain the response so the provider performs the authenticated request.
			}

			expect(authorization).toBe(`Bearer ${access}`);
		} finally {
			if (previous === undefined) Reflect.deleteProperty(process.env, "OPENAI_CODEX_API_KEY");
			else process.env.OPENAI_CODEX_API_KEY = previous;
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("uses stored GitHub Copilot credentials and the plan-specific host", async () => {
		const directory = await mkdtemp(join(tmpdir(), "codework-harness-copilot-"));
		const authFile = join(directory, "auth.json");
		const saved = { COPILOT_GITHUB_TOKEN: process.env.COPILOT_GITHUB_TOKEN };
		for (const name of Object.keys(saved)) Reflect.deleteProperty(process.env, name);

		try {
			await writeFile(
				authFile,
				JSON.stringify({
					"github-copilot": {
						access: "ghu_stored",
						refresh: "ghu_stored",
						expires: 0,
						apiEndpoint: "https://api.individual.githubcopilot.com",
					},
				}),
			);

			let authorization: string | null = null;
			let requested = "";
			const fetch = async (url: string | URL | Request, init?: RequestInit) => {
				requested = url instanceof URL ? url.href : typeof url === "string" ? url : url.url;
				authorization = new Headers(init?.headers).get("authorization");
				const chunk = (delta: Record<string, unknown>, finish: string | null) =>
					`data: ${JSON.stringify({
						id: "1",
						object: "chat.completion.chunk",
						created: 1,
						model: "gemini-3.6-flash",
						choices: [{ index: 0, delta, finish_reason: finish }],
					})}\n\n`;
				return new Response(
					`${chunk({ role: "assistant", content: "ok" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
					{
						headers: { "content-type": "text/event-stream" },
					},
				);
			};

			const model = await llm("github-copilot", "gemini-3.6-flash");
			expect(model).toBeDefined();
			if (!model) return;

			const events = await Effect.runPromise(
				LLM.openWith({ authFile })(
					{
						sessionId: SessionSchema.ID.create(),
						provider: "github-copilot",
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
						options: { maxRetries: 0, factoryOptions: { fetch } },
					},
					new AbortController().signal,
				),
			);
			for await (const _event of events) {
				// Drain the response so the provider performs the authenticated request.
			}

			expect(authorization).toBe("Bearer ghu_stored");
			// The login-time endpoint wins over the catalog's generic host.
			expect(requested).toContain("https://api.individual.githubcopilot.com");

			// An environment token may be another account, so it does not inherit
			// the stored login's plan-specific host.
			process.env.COPILOT_GITHUB_TOKEN = "ghu_from_env";
			const fromEnv = await Effect.runPromise(
				LLM.openWith({ authFile })(
					{
						sessionId: SessionSchema.ID.create(),
						provider: "github-copilot",
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
						options: { maxRetries: 0, factoryOptions: { fetch } },
					},
					new AbortController().signal,
				),
			);
			for await (const _event of fromEnv) {
				// Drain so the request is made.
			}
			expect(authorization).toBe("Bearer ghu_from_env");
			expect(requested).toContain("https://api.githubcopilot.com/");
		} finally {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) Reflect.deleteProperty(process.env, name);
				else process.env[name] = value;
			}
			await rm(directory, { recursive: true, force: true });
		}
	});

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
