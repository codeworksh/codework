// Sections are passed by value, never by name string, so a typo fails to compile instead of
// quietly opening a new section.

/** `text`: entries verbatim, blank-line separated. `list`: deduplicated `- ` bullets. */
export type Format = "text" | "list";

export interface Section<Name extends string = string> {
	readonly name: Name;
	readonly format: Format;
}

export const Rules: Section<"rules"> = Object.freeze({ name: "rules", format: "list" });
export const Addendum: Section<"addendum"> = Object.freeze({ name: "addendum", format: "text" });
export const ProjectContext: Section<"project_context"> = Object.freeze({ name: "project_context", format: "text" });
export const Skills: Section<"skills"> = Object.freeze({ name: "skills", format: "text" });

/** Rendered in this order, before custom sections. */
export const builtins: ReadonlyArray<Section> = Object.freeze([Rules, Addendum, ProjectContext, Skills]);

/** Rendered by the harness, never by a plugin. */
export const reserved: ReadonlySet<string> = new Set(["tools", "cwd", "foundation"]);

const pattern = /^[a-z][a-z0-9_-]*$/;

const formats: ReadonlySet<unknown> = new Set<Format>(["text", "list"]);

/** Runtime check: a JavaScript plugin can pass anything. */
export const isFormat = (format: unknown): format is Format => formats.has(format);

export const invalid = (name: unknown): string | undefined => {
	if (typeof name !== "string" || !pattern.test(name))
		return `prompt section name must be lowercase letters, digits, "_" or "-": ${JSON.stringify(name)}`;
	if (reserved.has(name)) return `prompt section name is reserved: ${name}`;
	return undefined;
};

/** A custom section. Throws on a name that is malformed, reserved, or built in. */
export const define = <const Name extends string>(
	name: Name,
	options?: { readonly format?: Format },
): Section<Name> => {
	const reason =
		invalid(name) ??
		(builtins.some((section) => section.name === name) ? `prompt section name is built in: ${name}` : undefined);
	if (reason !== undefined) throw new Error(reason);
	const format = options?.format ?? "text";
	if (!isFormat(format)) throw new Error(`prompt section format must be "text" or "list": ${JSON.stringify(format)}`);
	return Object.freeze({ name, format });
};
