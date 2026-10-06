/*
 * @file Renders the frozen prompt bucket into the system prompt string.
 *
 * The foundation comes first and untagged. Every section after it is a snake_case XML-style tag:
 * the harness-owned `<tools>`, the built-in sections, `<cwd>`, then custom sections in the order
 * a plugin first wrote them. Bodies are never escaped -- a plugin may nest its own tags in an entry.
 */

import * as Section from "@codeworksh/plugin/plugin/section";
import type { AnyToolDef } from "../../tool/tool.ts";
import { fallback, type Snapshot, type Written } from "./registry.ts";

interface Input {
	readonly prompt: Snapshot;
	/** The resolved tool catalog, in the order the provider receives definitions. */
	readonly tools: ReadonlyArray<AnyToolDef>;
	readonly directory: string;
}

const tag = (name: string, body: string): string => `<${name}>\n${body}\n</${name}>`;

/** Collapse whitespace so two spellings of one list entry dedupe against each other. */
const normalize = (value: string): string => value.trim().replace(/\s+/g, " ");

/** A section's body, or undefined when it has nothing to say. */
const body = ({ format, entries }: Written): string | undefined => {
	if (format === "text") {
		const kept = entries.filter((entry) => entry.trim().length > 0);
		return kept.length === 0 ? undefined : kept.join("\n\n");
	}
	const seen = new Set<string>();
	for (const entry of entries) {
		const normalized = normalize(entry);
		if (normalized.length > 0) seen.add(normalized);
	}
	return seen.size === 0 ? undefined : Array.from(seen, (line) => `- ${line}`).join("\n");
};

/**
 * The tool index.
 *
 * `(none)` rather than an omitted section: a model told it has no tools behaves better than one
 * left to infer it from silence.
 */
const toolIndex = (tools: ReadonlyArray<AnyToolDef>): string => {
	const listed = tools.filter((tool) => tool.promptSnippet !== undefined && tool.promptSnippet.length > 0);
	if (listed.length === 0) return "(none)";
	return listed.map((tool) => `- ${tool.name}: ${tool.promptSnippet}`).join("\n");
};

export const render = (input: Input): string => {
	const written = new Map(input.prompt.sections);

	// Tool guidelines lead `rules`, ahead of anything a plugin wrote there.
	const guidelines = input.tools.flatMap((tool) => tool.promptGuidelines ?? []);
	written.set(Section.Rules.name, {
		format: Section.Rules.format,
		entries: [...guidelines, ...(written.get(Section.Rules.name)?.entries ?? [])],
	});

	const parts: string[] = [input.prompt.foundation ?? fallback, tag("tools", toolIndex(input.tools))];
	const push = (name: string) => {
		const section = written.get(name);
		const rendered = section === undefined ? undefined : body(section);
		if (rendered !== undefined) parts.push(tag(name, rendered));
		written.delete(name);
	};

	for (const section of Section.builtins) push(section.name);
	parts.push(tag("cwd", input.directory));
	// What remains is custom, still in first-write order.
	for (const name of Array.from(written.keys())) push(name);

	return parts.join("\n\n");
};
