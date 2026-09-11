import { Effect } from "effect";
import { define } from "../../plugin.ts";

export const defaultPromptPlugin = define({
	id: "codework.prompt.default",
	setup: Effect.fn("DefaultPromptPlugin.setup")(function* (ctx) {
		const custom = ctx.config.promptCustom;
		const append = ctx.config.promptSystemAppend;
		const foundation =
			custom === undefined
				? "You are a coding assistant."
				: yield* Effect.tryPromise(() => Promise.resolve().then(() => custom(ctx)));
		const extra =
			append === undefined ? undefined : yield* Effect.tryPromise(() => Promise.resolve().then(() => append(ctx)));
		ctx.plugin.prompt.set([foundation, extra].filter((part) => part !== undefined).join("\n\n"));
	}),
});
