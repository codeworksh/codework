// Content only: the harness renders tools, tags and `<cwd>`.

import * as Section from "@codeworksh/plugin/plugin/section";
import { Effect } from "effect";
import type { PromptResolver, SharedPluginContext } from "../../context.ts";
import { define } from "../../plugin.ts";

/** The default prompt foundation, used unless `promptCustom` replaces it. */
const foundation =
	"You are an expert coding assistant operating inside codework, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

/** Every line here is spent on every request; keep it short. */
const standingRules: ReadonlyArray<string> = [
	"Be concise in your responses",
	"Show file paths clearly when working with files",
];

/** Bash stands in for file tools only until dedicated ones are registered. */
const toolRules = (names: ReadonlySet<string>): ReadonlyArray<string> =>
	names.has("bash") && !["grep", "find", "ls"].some((name) => names.has(name))
		? ["Use bash for file operations like ls, rg, find"]
		: [];

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
		const names = new Set(ctx.plugin.tools.list().map((tool) => tool.name));
		for (const rule of [...toolRules(names), ...standingRules]) prompt.sections.append(Section.Rules, rule);
		if (append !== undefined && append.length > 0) prompt.sections.append(Section.Addendum, append);
	}),
});
