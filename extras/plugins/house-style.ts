/*
 * A single-file prompt plugin. It writes each configured rule into the built-in `<rules>`, which
 * every plugin shares, so its rules merge with the defaults instead of opening a second block:
 *
 *   { "plugins": ["./plugins/house-style.ts",
 *                 { "package": "./plugins/house-style.ts", "options": { "rules": ["No `any`."] } }] }
 */
import { Plugin, Section } from "@codeworksh/plugin";

const readRules = (options: Plugin.PluginOptions): ReadonlyArray<string> => {
	const rules = options["rules"];
	return Array.isArray(rules) ? rules.filter((rule): rule is string => typeof rule === "string") : [];
};

export default Plugin.define({
	id: "local.prompt.house-style",
	kind: "prompt",
	setup(ctx, options) {
		for (const rule of readRules(options)) ctx.plugin.prompt.sections.append(Section.Rules, rule);
	},
});
