/*
 * A single-file plugin, loaded by path rather than installed. Relative entries anchor to the
 * file that declared them, so this one is named from the settings file beside it:
 *
 *   { "plugins": ["./plugins/local.ts",
 *                 { "package": "./plugins/local.ts", "options": { "facts": { "deploy": "vercel" } } }] }
 *
 * Two entries, because a string loads a module and an object only configures one already in the
 * selection. `{ "plugin": "local.tool.facts" }` addresses it by ID instead, if you prefer.
 *
 * It has no dependencies beyond the plugin surface: everything it reports comes from its own
 * configuration block, which makes it the shortest complete example of `setup(ctx, options)`.
 */
import { Plugin, Tool } from "@codeworksh/harness/effect";
import { Effect, Schema } from "effect";

/** The harness hands the block over untouched, so shape-check it here and ignore the rest. */
const readFacts = (options: Plugin.PluginOptions): Record<string, string> => {
	const facts = options["facts"];
	if (typeof facts !== "object" || facts === null || Array.isArray(facts)) return {};
	return Object.fromEntries(
		Object.entries(facts as Record<string, unknown>).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
};

export default Plugin.define({
	id: "local.tool.facts",
	kind: "tool",
	setup(ctx, options) {
		const facts = readFacts(options);
		const names = Object.keys(facts);
		// Nothing configured means nothing to answer with; registering an empty tool would
		// only spend context on a tool that can never help.
		if (names.length === 0) return;
		ctx.plugin.tools.add(
			Tool.register(
				Tool.make({
					name: "project_fact",
					label: "project fact",
					promptSnippet: `Look up a project convention: ${names.join(", ")}.`,
					description: `Look up a project convention recorded in this project's settings. Known keys: ${names.join(", ")}.`,
					parameters: Schema.Struct({
						key: Schema.String.annotate({ description: "The convention to look up." }),
					}),
					success: Schema.Struct({ key: Schema.String, value: Schema.String }),
					encodeContent: (success) => [{ type: "text", text: success.value }],
					handler: ({ key }) => {
						const value = facts[key];
						return value === undefined
							? Effect.succeed({ key, value: `No fact recorded for "${key}". Known keys: ${names.join(", ")}.` })
							: Effect.succeed({ key, value });
					},
				}),
			),
		);
	},
});
