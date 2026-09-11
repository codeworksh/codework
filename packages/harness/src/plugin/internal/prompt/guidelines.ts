import { define } from "../../plugin.ts";

export const guidelinesPromptPlugin = define({
	id: "codework.prompt.guidelines",
	setup(ctx) {
		const current = ctx.plugin.prompt.get();
		if (current === undefined) throw new Error("Expected an existing prompt");
		ctx.plugin.prompt.set(`${current}\n\nPrefer rg for searches. Keep changes focused.`);
	},
});
