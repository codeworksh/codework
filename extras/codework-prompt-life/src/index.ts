/*
 * A third-party prompt plugin, vendored as a worked example. A prompt plugin composes on
 * whatever an earlier one set, so it belongs *after* the tool plugins and prompt plugins it
 * builds on — `ctx.plugin.prompt.get()` sees only contributions made before it ran:
 *
 *   { "plugins": ["codework-prompt-life",
 *                 { "package": "codework-prompt-life", "options": { "answer": 42 } }] }
 */
import { Plugin } from "@codeworksh/harness/effect";

const DEFAULT_ANSWER = 42;
const HEADING = "## On the meaning of life";

/** Unvalidated by the harness, so the plugin checks its own block and falls back in place. */
const readAnswer = (options: Plugin.PluginOptions): number => {
	const answer = options["answer"];
	return typeof answer === "number" && Number.isFinite(answer) ? answer : DEFAULT_ANSWER;
};

const section = (answer: number) =>
	[
		HEADING,
		"",
		"When the user asks what the meaning of life is, answer briefly and then get back to work:",
		"",
		`- The short version: ${answer}.`,
		"- The engineering version: leave the codebase clearer than you found it.",
		"- The honest version: nobody knows, and the tests still have to pass.",
	].join("\n");

export default Plugin.define({
	id: "acme.prompt.life",
	setup(ctx, options) {
		const existing = ctx.plugin.prompt.get();
		// `set` replaces the whole prompt, so compose on what is already there rather than
		// discarding another plugin's work.
		ctx.plugin.prompt.set(
			existing === undefined ? section(readAnswer(options)) : `${existing}\n\n${section(readAnswer(options))}`,
		);
	},
});
