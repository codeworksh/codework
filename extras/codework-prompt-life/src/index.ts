/*
 * A third-party prompt plugin, vendored as a worked example. It opens its own section,
 * `<meaning_of_life>`, which the harness renders after the built-in ones:
 *
 *   { "plugins": ["@acme/codework-prompt-life",
 *                 { "package": "@acme/codework-prompt-life", "options": { "answer": 42 } }] }
 */
import { Plugin, Section } from "@codeworksh/plugin";

const DEFAULT_ANSWER = 42;

const MeaningOfLife = Section.define("meaning_of_life");

/** Unvalidated by the harness, so the plugin checks its own block and falls back in place. */
const readAnswer = (options: Plugin.PluginOptions): number => {
	const answer = options["answer"];
	return typeof answer === "number" && Number.isFinite(answer) ? answer : DEFAULT_ANSWER;
};

const body = (answer: number) =>
	[
		"When the user asks what the meaning of life is, answer briefly and then get back to work:",
		"",
		`- The short version: ${answer}.`,
		"- The engineering version: leave the codebase clearer than you found it.",
		"- The honest version: nobody knows, and the tests still have to pass.",
	].join("\n");

export default Plugin.define({
	id: "acme.prompt.life",
	kind: "prompt",
	setup(ctx, options) {
		ctx.plugin.prompt.sections.append(MeaningOfLife, body(readAnswer(options)));
	},
});
