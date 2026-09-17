/*
 * @file The built-in Prompt plugin: `codework.prompt.default`.
 *
 * Everything below `setup` is plugin-private. The Prompt domain stores one string
 * and imposes no shape, so this file — not the kernel — owns the foundation, the
 * tool index, the guideline dedupe and the working-directory line. A third party
 * that wants a different prompt omits this plugin or `set`s over it.
 */

import { Effect } from "effect";
import type { AnyToolDef } from "../../../tool/tool.ts";
import type { PromptResolver, SharedPluginContext } from "../../context.ts";
import { define } from "../../plugin.ts";

/** The default coding-agent foundation, used unless `promptCustom` replaces it. */
const foundation = `You are an expert coding assistant operating inside codework, a coding agent harness.`;

/**
 * Guidelines that hold regardless of which tools are registered.
 *
 * Kept short on purpose. Every line here is spent on every request, so a line
 * earns its place only if a model measurably behaves worse without it.
 */
const standingGuidelines: ReadonlyArray<string> = [
	"Be concise. Report what you did and what you found, not what you are about to do.",
	"Quote exact paths and command output rather than paraphrasing them.",
	"If a command fails, read the error before retrying.",
];

/** Collapse whitespace so two spellings of one guideline dedupe against each other. */
const normalize = (value: string): string => value.trim().replace(/\s+/g, " ");

/**
 * Tool-contributed guidelines followed by the standing ones, normalized and
 * deduplicated with first occurrence winning.
 *
 * Tool order is bucket order, which is the same order the index renders in and the
 * same order the provider receives definitions in -- one ordering, not three.
 */
const guidelines = (tools: ReadonlyArray<AnyToolDef>): ReadonlyArray<string> => {
	const seen = new Set<string>();
	const collected: string[] = [];
	for (const line of [...tools.flatMap((tool) => tool.promptGuidelines ?? []), ...standingGuidelines]) {
		const normalized = normalize(line);
		if (normalized.length === 0 || seen.has(normalized)) continue;
		seen.add(normalized);
		collected.push(normalized);
	}
	return collected;
};

/**
 * The rendered tool index.
 *
 * `(none)` rather than an omitted section: a model told it has no tools behaves
 * better than one left to infer it from silence.
 */
const toolIndex = (tools: ReadonlyArray<AnyToolDef>): string => {
	const listed = tools.filter((tool) => tool.promptSnippet !== undefined && tool.promptSnippet.length > 0);
	if (listed.length === 0) return "(none)";
	return listed.map((tool) => `- ${tool.name}: ${tool.promptSnippet}`).join("\n");
};

interface Input {
	readonly tools: ReadonlyArray<AnyToolDef>;
	readonly directory: string;
	readonly promptCustom?: string;
	readonly promptSystemAppend?: string;
}

const assemble = (input: Input): string => {
	const sections: string[] = [input.promptCustom ?? foundation];

	sections.push(`Available tools:\n${toolIndex(input.tools)}`);

	const lines = guidelines(input.tools);
	if (lines.length > 0) sections.push(`Guidelines:\n${lines.map((line) => `- ${line}`).join("\n")}`);

	const append = input.promptSystemAppend?.trim();
	if (append !== undefined && append.length > 0) sections.push(append);

	sections.push(`Current working directory: ${input.directory}`);

	return sections.join("\n\n");
};

/**
 * A caller slot, awaited lazily. A throw or rejection fails the snapshot, which the
 * host attributes to this plugin's id.
 */
const slot = (ctx: SharedPluginContext, resolver: PromptResolver | undefined) =>
	Effect.tryPromise(() => Promise.resolve(resolver?.(ctx)));

export const defaultPromptPlugin = define({
	id: "codework.prompt.default",
	setup: Effect.fn("DefaultPromptPlugin.setup")(function* (ctx) {
		const custom = yield* slot(ctx, ctx.config.promptCustom);
		const append = yield* slot(ctx, ctx.config.promptSystemAppend);
		ctx.plugin.prompt.set(
			assemble({
				// Only tools registered by an earlier plugin are visible here.
				tools: ctx.plugin.tools.list(),
				directory: ctx.location.directory,
				...(custom === undefined ? {} : { promptCustom: custom }),
				...(append === undefined ? {} : { promptSystemAppend: append }),
			}),
		);
	}),
});
