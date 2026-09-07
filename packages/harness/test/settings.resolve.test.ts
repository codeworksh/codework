import { Model } from "@codeworksh/aikit";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { merge } from "../src/settings/merge.ts";
import { collect, compose, resolveOptions, resolveOverrides, resolveRequest } from "../src/settings/resolve.ts";
import { defaults, type Patch } from "../src/settings/schema.ts";
import { parse } from "../src/settings/settings.ts";

const configured = (patch: Patch) => merge(defaults, patch);

describe("settings resolution", () => {
	it("merges every matching block from general to exact with stable specificity ties", () => {
		const settings = configured({
			model: {
				options: { timeoutMs: 90000, headers: { a: "global", b: "global" } },
				providerOptions: {
					openai: {
						"gpt-5.6-*": { timeoutMs: 400, headers: { b: "pattern" } },
						"gpt-*": { timeoutMs: 300, headers: { c: "broad" } },
						"*": { timeoutMs: 200 },
						"gpt-5.6-luna": { timeoutMs: 100, headers: { d: "exact" } },
						"gpt-5-6-*": { timeoutMs: 1 },
					},
				},
			},
		});
		expect(collect(settings, "openai", "gpt-5.6-luna")).toMatchObject({
			timeoutMs: 100,
			headers: { a: "global", b: "pattern", c: "broad", d: "exact" },
		});
		expect(collect(settings, "openai", "gpt-5.6-sol").timeoutMs).toBe(400);
		const ties = configured({
			model: { providerOptions: { openrouter: { "qwen/*max": { maxTokens: 1 }, "qwen/*": { maxTokens: 2 } } } },
		});
		expect(collect(ties, "openrouter", "qwen/qwen3.7-max").maxTokens).toBe(2);
	});

	it("ignores nulls at every object level, replaces arrays, and keeps inputs unchanged", async () => {
		const patch = await Effect.runPromise(
			parse(
				"settings.json",
				JSON.stringify({
					model: {
						provider: null,
						options: {
							timeoutMs: null,
							headers: { a: null, b: "new" },
							providerArray: ["one"],
							extras: { organization: null },
						},
						providerOptions: { openai: { "*": { timeoutMs: null } } },
					},
				}),
			),
		);
		const base = configured({
			model: {
				options: { headers: { a: "inherited" }, providerArray: ["one", "two"], extras: { organization: "org" } },
			},
		});
		const result = collect(merge(base, patch), "openai", "anything");
		expect(result).toMatchObject({
			timeoutMs: 90000,
			headers: { a: "inherited", b: "new" },
			providerArray: ["one"],
			extras: { organization: "org" },
		});
		expect(base.model.options?.providerArray).toEqual(["one", "two"]);
		expect(merge(defaults, patch).model.provider).toBe("openai");
	});

	it("routes harness controls separately and matches the runtime selection before resolving", () => {
		const settings = configured({
			model: {
				thinkingLevel: "low",
				providerOptions: {
					lmstudio: {
						"*": {
							thinkingLevel: "off",
							toolExecution: "parallel",
							baseURL: "http://localhost:6900/v1",
							contextWindow: 1234,
							maxTokens: 512,
							extras: { name: "local" },
							unknownProviderOption: true,
						},
					},
				},
			},
		});
		const result = compose(settings, {}, { provider: "lmstudio", model: "qwen/model" });
		expect(result).toMatchObject({
			thinkingLevel: "off",
			toolExecution: "parallel",
			provider: "lmstudio",
			model: "qwen/model",
		});
		const model = { protocol: Model.KnownProviderEnum.openaiCompatible } as Model.Info;
		const request = resolveRequest(result.block, model);
		expect(request).toMatchObject({
			baseURL: "http://localhost:6900/v1",
			maxTokens: 512,
			factoryOptions: { name: "local" },
			providerOptions: { "openai-compatible": { unknownProviderOption: true } },
		});
		expect(resolveOverrides(result.block)).toEqual({ contextWindow: 1234 });
		expect(request).not.toHaveProperty("contextWindow");
		expect(request).not.toHaveProperty("thinkingLevel");
		expect(compose(settings).thinkingLevel).toBe("low");
		expect(
			compose(settings, { thinkingLevel: "medium" }, { provider: "lmstudio", thinkingLevel: "high" }).thinkingLevel,
		).toBe("high");
		expect(compose(settings, { provider: "unknown", model: "missing" })).toMatchObject({
			provider: "unknown",
			model: "missing",
		});
	});

	it("keeps blocks for other providers out of the selection", () => {
		const settings = configured({
			model: {
				providerOptions: {
					openai: { "*": { maxTokens: 111 }, "shared-id": { temperature: 0.1 } },
					anthropic: { "*": { maxTokens: 222 } },
				},
			},
		});
		// The same model id under a different provider must not inherit the other's block.
		expect(collect(settings, "anthropic", "shared-id")).toMatchObject({ maxTokens: 222 });
		expect(collect(settings, "anthropic", "shared-id")).not.toHaveProperty("temperature");
		// A provider with no blocks at all falls back to the top-level options only.
		expect(collect(settings, "google", "shared-id").maxTokens).toBeUndefined();
	});

	it("preserves same-path file precedence followed by model specificity", () => {
		const global = { model: { providerOptions: { openai: { exact: { maxTokens: 400 } } } } };
		const local = { model: { options: { maxTokens: 200 } } };
		const custom = { model: { providerOptions: { openai: { exact: { maxTokens: 800 } } } } };
		expect(collect(merge(defaults, global, local), "openai", "exact").maxTokens).toBe(400);
		expect(collect(merge(defaults, global, local, custom), "openai", "exact").maxTokens).toBe(800);
	});

	it("rejects tool selection settings in global and provider/model option blocks", async () => {
		for (const block of [{ toolChoice: "auto" }, { activeTools: ["bash"] }]) {
			for (const model of [
				{ options: block },
				...["*", "gpt-*", "gpt-5.5"].map((pattern) => ({ providerOptions: { openai: { [pattern]: block } } })),
			]) {
				const error = await Effect.runPromise(parse("settings.json", JSON.stringify({ model })).pipe(Effect.flip));
				expect(error.reason).toBe("decode");
			}
		}
	});

	it("validates known keys and retains arbitrary provider keys", async () => {
		for (const options of [
			{ timeoutMs: "slow" },
			{ thinkingLevel: "extreme" },
			{ protocol: "openai" },
			{ apiKey: "secret" },
		]) {
			await expect(Effect.runPromise(parse("bad.json", JSON.stringify({ model: { options } })))).rejects.toThrow();
		}
		const patch = await Effect.runPromise(parse("ok.json", '{"model":{"options":{"serviceTier":"auto"}}}'));
		expect(patch.model?.options?.serviceTier).toBe("auto");
		expect(resolveOptions({ thinkingBudgets: { high: 123 }, metadata: { user: "test" } })).toEqual({
			thinkingBudgets: { high: 123 },
			metadata: { user: "test" },
		});
	});
});
