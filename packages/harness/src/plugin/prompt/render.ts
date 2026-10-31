// Bodies are never escaped: a plugin may nest its own tags inside an entry.

import * as Section from "@codeworksh/plugin/plugin/section";
import type { AnyToolDef } from "../../tool/tool.ts";
import { fallback, type Snapshot, type Written } from "./registry.ts";

interface Input {
	readonly prompt: Snapshot;
	readonly tools: ReadonlyArray<AnyToolDef>;
	readonly directory: string;
}

const tag = (name: string, body: string): string => `<${name}>\n${body}\n</${name}>`;

/** Two spellings of one list entry dedupe against each other. */
const normalize = (value: string): string => value.trim().replace(/\s+/g, " ");

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

/** `(none)` rather than no section: a model told it has no tools behaves better than one left guessing. */
const toolIndex = (tools: ReadonlyArray<AnyToolDef>): string => {
	const listed = tools.filter((tool) => tool.promptSnippet !== undefined && tool.promptSnippet.length > 0);
	if (listed.length === 0) return "(none)";
	return listed.map((tool) => `- ${tool.name}: ${tool.promptSnippet}`).join("\n");
};

/**
 * The prompt as the transcript carries it: the untagged foundation, then named sections, each
 * holding its own tags. A section's text is compared whole between requests, so one that did not
 * change is never sent again.
 */
export interface Rendered {
	readonly foundation: string;
	readonly sections: Readonly<Record<string, string>>;
}

export const render = (input: Input): Rendered => {
	const written = new Map(input.prompt.sections);

	const guidelines = input.tools.flatMap((tool) => tool.promptGuidelines ?? []);
	written.set(Section.Rules.name, {
		format: Section.Rules.format,
		entries: [...guidelines, ...(written.get(Section.Rules.name)?.entries ?? [])],
	});

	const sections: Record<string, string> = { tools: tag("tools", toolIndex(input.tools)) };
	const push = (name: string) => {
		const section = written.get(name);
		const rendered = section === undefined ? undefined : body(section);
		if (rendered !== undefined) sections[name] = tag(name, rendered);
		written.delete(name);
	};

	for (const section of Section.builtins) push(section.name);
	sections.cwd = tag("cwd", input.directory);
	for (const name of Array.from(written.keys())) push(name);

	// A blank foundation would leave the Responses transport without instructions, and it would
	// promote the first system message in its stead.
	const foundation = input.prompt.foundation?.trim() ? input.prompt.foundation : fallback;
	return { foundation, sections };
};
