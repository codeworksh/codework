import * as Section from "@codeworksh/plugin/plugin/section";
import type { PromptRegistry } from "./schema.ts";

/**
 * The foundation used when no plugin set one.
 *
 * A selection with no prompt plugin is a legitimate configuration -- an embedder
 * passing `plugins: []`, or a user disabling `codework.prompt.default` before
 * their own plugin is ready -- and failing the exchange over it buys nothing the
 * assembled prompt would not already tell them. The real foundation lives in
 * `codework.prompt.default`; this is only the floor.
 */
export const fallback = "You are an expert coding assistant operating inside codework, a coding agent harness.";

/** The format is fixed by the first write. */
export interface Written {
	readonly format: Section.Format;
	readonly entries: ReadonlyArray<string>;
}

export interface Snapshot {
	readonly foundation: string | undefined;
	readonly sections: ReadonlyMap<string, Written>;
}

export const make = () => {
	let open = true;
	let foundation: string | undefined;
	const sections = new Map<string, { readonly format: Section.Format; entries: string[] }>();

	const writable = () => {
		if (!open) throw new Error("prompt registry is closed");
	};
	// Checked at runtime too: a JavaScript plugin can hand-build a Section.
	const slot = (section: Section.Section) => {
		writable();
		const reason = Section.invalid(section.name);
		if (reason !== undefined) throw new Error(reason);
		if (!Section.isFormat(section.format))
			throw new Error(`prompt section ${section.name} has an unknown format: ${JSON.stringify(section.format)}`);
		const builtin = Section.builtins.find((candidate) => candidate.name === section.name);
		if (builtin !== undefined && builtin.format !== section.format)
			throw new Error(`prompt section ${section.name} is built in as "${builtin.format}"`);
		const existing = sections.get(section.name);
		if (existing === undefined) {
			const opened = { format: section.format, entries: [] };
			sections.set(section.name, opened);
			return opened;
		}
		if (existing.format !== section.format)
			throw new Error(
				`prompt section ${section.name} is "${existing.format}"; a write as "${section.format}" cannot merge into it`,
			);
		return existing;
	};

	const registry: PromptRegistry = Object.freeze({
		foundation: Object.freeze({
			set: (text: string) => {
				writable();
				foundation = text;
			},
			get: () => foundation,
		}),
		sections: Object.freeze({
			append: (section: Section.Section, entry: string) => {
				slot(section).entries.push(entry);
			},
			set: (section: Section.Section, entries: ReadonlyArray<string>) => {
				slot(section).entries = [...entries];
			},
			remove: (section: Section.Section) => {
				writable();
				sections.delete(section.name);
			},
			get: (section: Section.Section) => {
				const found = sections.get(section.name);
				return found === undefined ? undefined : Object.freeze([...found.entries]);
			},
		}),
	});

	return {
		registry,
		close: () => {
			open = false;
		},
		snapshot: (): Snapshot => ({
			foundation,
			sections: new Map(
				Array.from(sections, ([name, { format, entries }]) => [name, { format, entries: [...entries] }] as const),
			),
		}),
	};
};
