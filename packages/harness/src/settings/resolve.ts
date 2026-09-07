/*
 * @file The settings transform layer: a sparse, authored file becomes resolved values.
 *
 * `Settings.Info` is written for editing -- nested, partial, patterned, every field
 * optional. A snapshot is read at runtime -- flat and resolved. This module is the only
 * place that knows how one becomes the other, and it is deliberately pure: no services,
 * no file reads, no catalog lookup. Keep it that way and the file format stays free to
 * change without touching the loop.
 *
 * A key routes by its *name*, never by where it was written, which is what lets the same
 * key appear at global, provider, pattern, or exact-id scope. Names split four ways:
 * `contextWindow` corrects the catalog entry, request fields reach `stream()`, `extras`
 * reaches the provider constructor, and anything unrecognised falls through to the
 * per-request provider bag. That last rule is why a provider option aikit has never heard
 * of needs no registration here.
 *
 * Resolution is two-phase because the bag's key is `Model.optionsKey(model)`, which is only
 * knowable after the catalog lookup. Phase one produces the overrides that lookup needs;
 * phase two runs at the LLM boundary with the resolved model in hand.
 */

import { Model } from "@codeworksh/aikit";
import type { State } from "../state/state.ts";
import { merge } from "./merge.ts";
import { requestFields, type Block, type Info } from "./schema.ts";

const patternMatches = (pattern: string, id: string) =>
	new RegExp(
		`^${pattern
			.split("*")
			.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*")}$`,
	).test(id);

export function collect(settings: Info, provider: string, id: string): Block {
	const config = settings.model;
	const blocks = config.providerOptions?.[provider] ?? {};
	const patterns = Object.keys(blocks)
		.filter((key) => key !== "*" && key !== id && key.includes("*") && patternMatches(key, id))
		.sort((a, b) => a.indexOf("*") - b.indexOf("*"));
	return merge<Block>(
		{
			thinkingLevel: config.thinkingLevel,
			toolExecution: config.toolExecution,
			...(config.thinkingBudgets === undefined ? {} : { thinkingBudgets: config.thinkingBudgets }),
		},
		config.options,
		blocks["*"],
		...patterns.map((key) => blocks[key]),
		blocks[id],
	);
}

export const resolveOverrides = (block: Block): Partial<Model.Info> =>
	block.contextWindow === undefined ? {} : { contextWindow: block.contextWindow };

/** Protocol-independent request attributes can already be captured by State. */
export function resolveOptions(block: Block): State.RequestOptions {
	const request = Object.fromEntries(Object.entries(block).filter(([key]) => Object.hasOwn(requestFields, key)));
	return { ...request, ...(block.extras === undefined ? {} : { factoryOptions: merge({}, block.extras) }) };
}

/** The bag key becomes knowable only after lookup at the LLM boundary. */
export function resolveRequest(block: Block, model: Model.Info): State.RequestOptions {
	const bag = Object.fromEntries(
		Object.entries(block).filter(
			([key]) =>
				!Object.hasOwn(requestFields, key) &&
				!["thinkingLevel", "toolExecution", "contextWindow", "extras"].includes(key),
		),
	);
	return {
		...resolveOptions(block),
		...(Object.keys(bag).length === 0 ? {} : { providerOptions: { [Model.optionsKey(model)]: bag } }),
	};
}

/**
 * Harness-owned controls, which never reach a provider.
 *
 * Separate from {@link resolveRequest} because these steer the loop itself -- how hard to
 * think, how to schedule tool calls -- rather than the request body. Runtime bindings
 * outrank a matched block, which outranks the file's top level.
 */
export const resolveControls = (settings: Info, block: Block, runtime: State.Options) => ({
	thinkingLevel: runtime.thinkingLevel ?? block.thinkingLevel ?? settings.model.thinkingLevel,
	toolExecution: runtime.toolExecution ?? block.toolExecution ?? settings.model.toolExecution,
});

/** Pure configuration composition. Domain selections need not exist in the catalog. */
export function compose(settings: Info, options: State.Options = {}, session: State.Options = {}) {
	const runtime = merge(options, session);
	const provider = runtime.provider ?? settings.model.provider;
	const model = runtime.model ?? settings.model.id;
	const block = collect(settings, provider, model);
	return { provider, model, ...resolveControls(settings, block, runtime), block, runtime };
}
