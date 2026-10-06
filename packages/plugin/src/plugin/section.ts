/**
 * Named sections of the system prompt.
 *
 * The prompt is a foundation (untagged head text) followed by sections, each rendered as a
 * snake_case XML-style tag. A plugin writes into a section by value, never by string, so a typo
 * fails to compile instead of quietly opening a new section.
 *
 * Sections merge by name: two plugins writing to `Rules`, or to their own `define("notes")`, fill
 * one `<rules>` / `<notes>`. `tools` and `cwd` are rendered by the harness and are not writable.
 */

/**
 * How a section's entries render.
 *
 * - `text`: entries verbatim, separated by a blank line.
 * - `list`: entries whitespace-collapsed, deduplicated (first wins), rendered as `- ` bullets.
 */
export type Format = "text" | "list";

export interface Section<Name extends string = string> {
	readonly name: Name;
	readonly format: Format;
}

/** Built-ins a plugin may write to. The harness renders them in this order, before custom ones. */
export const Rules: Section<"rules"> = Object.freeze({ name: "rules", format: "list" });
export const Addendum: Section<"addendum"> = Object.freeze({ name: "addendum", format: "text" });
export const ProjectContext: Section<"project_context"> = Object.freeze({ name: "project_context", format: "text" });
export const Skills: Section<"skills"> = Object.freeze({ name: "skills", format: "text" });

/** The writable built-ins, in render order. */
export const builtins: ReadonlyArray<Section> = Object.freeze([Rules, Addendum, ProjectContext, Skills]);

/** Names no plugin may define: harness-rendered sections and the untagged head. */
export const reserved: ReadonlySet<string> = new Set(["tools", "cwd", "foundation"]);

const pattern = /^[a-z][a-z0-9_]*$/;

const formats: ReadonlySet<unknown> = new Set<Format>(["text", "list"]);

/** True for a format the renderer knows; a JavaScript plugin can hand over anything. */
export const isFormat = (format: unknown): format is Format => formats.has(format);

/** Why `name` cannot be written to as a section, or undefined when it can. */
export const invalid = (name: unknown): string | undefined => {
	if (typeof name !== "string" || !pattern.test(name))
		return `prompt section name must be snake_case: ${JSON.stringify(name)}`;
	if (reserved.has(name)) return `prompt section name is reserved: ${name}`;
	return undefined;
};

/**
 * A custom section. Throws on a name that is not snake_case, is reserved, or belongs to a
 * built-in -- use the built-in value for those.
 */
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
