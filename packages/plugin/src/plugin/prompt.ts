import type { Section } from "./section.ts";

export interface PromptRegistry {
	/** The untagged head of the system prompt; the last `set` wins. */
	readonly foundation: {
		readonly set: (text: string) => void;
		readonly get: () => string | undefined;
	};
	readonly sections: {
		readonly append: (section: Section, entry: string) => void;
		readonly set: (section: Section, entries: ReadonlyArray<string>) => void;
		/** Writing a removed section again opens a new one, last in order. */
		readonly remove: (section: Section) => void;
		readonly get: (section: Section) => ReadonlyArray<string> | undefined;
	};
}
