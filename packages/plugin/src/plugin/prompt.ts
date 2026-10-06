import type { Section } from "./section.ts";

/**
 * The prompt bucket a plugin writes into during `setup`.
 *
 * The harness renders the system prompt from it: the foundation first and untagged, then the
 * harness-owned `<tools>`, the built-in sections, `<cwd>`, and finally custom sections in the order
 * they were first written.
 */
export interface PromptRegistry {
	/** The untagged head of the system prompt. One value; the last `set` wins. */
	readonly foundation: {
		readonly set: (text: string) => void;
		readonly get: () => string | undefined;
	};
	readonly sections: {
		/** Open the section on first use, otherwise add an entry to it. */
		readonly append: (section: Section, entry: string) => void;
		/** Replace every entry in the section. */
		readonly set: (section: Section, entries: ReadonlyArray<string>) => void;
		/** Drop the section. Writing it again opens a new one: last in order, format chosen afresh. */
		readonly remove: (section: Section) => void;
		readonly get: (section: Section) => ReadonlyArray<string> | undefined;
	};
}
