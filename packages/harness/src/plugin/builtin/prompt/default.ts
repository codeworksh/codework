/*
 * @file The built-in Prompt plugin: `codework.prompt.default`.
 *
 * Content only. The harness renders the prompt -- the tool index, the guideline dedupe, the tags and
 * the `<cwd>` -- so this plugin writes the foundation, the standing rules and the caller's append.
 * A third party that wants a different foundation omits this plugin or `set`s over it.
 */

import * as Section from "@codeworksh/plugin/plugin/section";
import { Effect } from "effect";
import type { PromptResolver, SharedPluginContext } from "../../context.ts";
import { define } from "../../plugin.ts";

/** The default coding-agent foundation, used unless `promptCustom` replaces it. */
const foundation = `You are an expert coding assistant operating inside codework, a coding agent harness.`;

/**
 * Rules that hold regardless of which tools are registered.
 *
 * Kept short on purpose. Every line here is spent on every request, so a line
 * earns its place only if a model measurably behaves worse without it.
 */
const standingRules: ReadonlyArray<string> = [
	"Be concise. Report what you did and what you found, not what you are about to do.",
	"Quote exact paths and command output rather than paraphrasing them.",
	"If a command fails, read the error before retrying.",
];

/**
 * A caller slot, awaited lazily. A throw or rejection fails the snapshot, which the
 * host attributes to this plugin's id.
 */
const slot = (ctx: SharedPluginContext, resolver: PromptResolver | undefined) =>
	Effect.tryPromise(() => Promise.resolve(resolver?.(ctx)));

export const defaultPromptPlugin = define({
	id: "codework.prompt.default",
	kind: "prompt",
	setup: Effect.fn("DefaultPromptPlugin.setup")(function* (ctx) {
		const custom = yield* slot(ctx, ctx.config.promptCustom);
		const append = (yield* slot(ctx, ctx.config.promptSystemAppend))?.trim();
		const prompt = ctx.plugin.prompt;
		prompt.foundation.set(custom ?? foundation);
		for (const rule of standingRules) prompt.sections.append(Section.Rules, rule);
		if (append !== undefined && append.length > 0) prompt.sections.append(Section.Addendum, append);
	}),
});
