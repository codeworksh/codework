/*
 * A single-file prompt plugin. A prompt plugin replaces the whole system prompt, so it composes
 * on what earlier plugins set and belongs after them:
 *
 *   { "plugins": ["./plugins/house-style.ts",
 *                 { "package": "./plugins/house-style.ts", "options": { "rules": ["No `any`."] } }] }
 *
 * Settings entries land after the built-ins, so this runs after `codework.prompt.default` and
 * appends to the prompt it rendered — which is where a prompt plugin wants to be. A settings
 * file cannot reorder the built-ins; `Harness.layer({ plugins })` owns the order when it matters.
 */
import { Plugin } from "@codeworksh/harness/effect";

const HEADING = "## House style";

const readRules = (options: Plugin.PluginOptions): ReadonlyArray<string> => {
	const rules = options["rules"];
	return Array.isArray(rules) ? rules.filter((rule): rule is string => typeof rule === "string") : [];
};

export default Plugin.define({
	id: "local.prompt.house-style",
	kind: "prompt",
	setup(ctx, options) {
		const rules = readRules(options);
		if (rules.length === 0) return;
		const section = [HEADING, "", ...rules.map((rule) => `- ${rule}`)].join("\n");
		const existing = ctx.plugin.prompt.get();
		ctx.plugin.prompt.set(existing === undefined ? section : `${existing}\n\n${section}`);
	},
});
