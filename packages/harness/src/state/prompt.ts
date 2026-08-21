/*
 * @file Pure system-prompt construction.
 *
 * Nothing here reads a service, a clock, or a filesystem. Given the same inputs
 * it returns the same string, byte for byte -- which is what lets the prompt be
 * asserted in a test and cached by a provider across a turn's continuations.
 *
 * The chain has three caller slots:
 *
 *   foundation --promptCustom?--> base
 *     -> tools + guidelines
 *     -> promptSystemAppend
 *     -> working directory
 *     -> promptSystemOverride(rendered) -> final
 *
 * `promptSystemOverride` is applied by the caller of {@link build}, not here: it
 * may be async, and this module stays pure.
 */

import type { Model } from "@codeworksh/aikit";
import type { SandboxIO } from "../sandbox/io.ts";
import type { Location } from "../location/location.ts";
import type { AnyToolDef } from "../tools/tool.ts";
import type { ToolExecutionMode } from "./state.ts";

/** The default coding-agent foundation, used unless `promptCustom` replaces it. */
export const foundation = `You are an expert coding assistant operating inside codework, a coding agent harness.`;

/**
 * Guidelines that hold regardless of which tools are registered.
 *
 * Kept short on purpose. Every line here is spent on every request, so a line
 * earns its place only if a model measurably behaves worse without it.
 */
export const standingGuidelines: ReadonlyArray<string> = [
	"Be concise. Report what you did and what you found, not what you are about to do.",
	"Quote exact paths and command output rather than paraphrasing them.",
	"If a command fails, read the error before retrying.",
];

export interface BuildInput {
	/**
	 * The effective tool set, in registry order. Only tools carrying a
	 * `promptSnippet` reach the rendered index; the rest stay callable but
	 * unlisted.
	 */
	readonly tools: ReadonlyArray<AnyToolDef>;
	/** The working directory, always `Location.directory` */
	readonly directory: string;
	/** Replaces {@link foundation} when supplied. */
	readonly promptCustom?: string;
	/** Appended after the tool sections, before the working-directory line. */
	readonly promptSystemAppend?: string;
}

/** Collapse whitespace so two spellings of one guideline dedupe against each other. */
const normalize = (value: string): string => value.trim().replace(/\s+/g, " ");

/**
 * Tool-contributed guidelines followed by the standing ones, normalized and
 * deduplicated with first occurrence winning.
 *
 * Tool order is registry order, which is the same order the index renders in and
 * the same order the provider receives definitions in -- one ordering, not three.
 */
export const guidelines = (tools: ReadonlyArray<AnyToolDef>): ReadonlyArray<string> => {
	const seen = new Set<string>();
	const collected: string[] = [];
	const add = (value: string) => {
		const line = normalize(value);
		if (line.length === 0 || seen.has(line)) return;
		seen.add(line);
		collected.push(line);
	};
	for (const tool of tools) for (const line of tool.promptGuidelines ?? []) add(line);
	for (const line of standingGuidelines) add(line);
	return collected;
};

/**
 * The rendered tool index.
 *
 * `(none)` rather than an omitted section: a model told it has no tools behaves
 * better than one left to infer it from silence.
 */
export const toolIndex = (tools: ReadonlyArray<AnyToolDef>): string => {
	const listed = tools.filter((tool) => tool.promptSnippet !== undefined && tool.promptSnippet.length > 0);
	if (listed.length === 0) return "(none)";
	return listed.map((tool) => `- ${tool.name}: ${tool.promptSnippet}`).join("\n");
};

export const build = (input: BuildInput): string => {
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
 * What the override sees. The rendered prompt plus the runtime facts it was
 * rendered from, so a caller can rebuild any part of it rather than only append.
 *
 * `tools` is the same resolved set the provider receives, which is what makes a
 * full override viable without losing the index.
 *
 * Conversation messages are deliberately absent. A hook that could read the
 * transcript is a provider-step concern, not runtime state.
 */
export interface PromptSystemOverrideInput {
	readonly systemPrompt: string;
	readonly tools: ReadonlyArray<AnyToolDef>;
	readonly sandbox: SandboxIO.Identity;
	readonly location: Location.Info;
	readonly provider: string;
	readonly model: string;
	readonly thinkingLevel: Model.ThinkingLevel;
	readonly toolExecution: ToolExecutionMode;
}

/**
 * The final link in the chain. Its return value is the prompt, verbatim.
 *
 * Sync or async: a caller integrating a non-Effect SDK should not have to reach
 * for Effect to change a string. A throw or rejection becomes a typed
 * `State.SnapshotError`, never a defect.
 */
export type PromptSystemOverride = (input: PromptSystemOverrideInput) => string | PromiseLike<string>;

export * as StatePrompt from "./prompt.ts";
