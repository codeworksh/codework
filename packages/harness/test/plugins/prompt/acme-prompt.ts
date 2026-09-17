import { define } from "../../../src/plugin/plugin.ts";
// Single-file prompt plugin: composes on whatever an earlier prompt plugin set, and reads
// its own configuration block — unvalidated by the harness, checked here like any plugin.
export default define({
	id: "acme.prompt.marker",
	setup(ctx, options) {
		const marker = typeof options.marker === "string" ? options.marker : "acme-marker";
		ctx.plugin.prompt.set(`${ctx.plugin.prompt.get() ?? ""}\n\n${marker}`);
	},
});
