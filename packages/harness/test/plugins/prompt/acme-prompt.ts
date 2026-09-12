import { define } from "../../../src/plugin/plugin.ts";
// Single-file prompt plugin: composes on whatever an earlier prompt plugin set.
export default define({
	id: "acme.prompt.marker",
	setup(ctx) {
		ctx.plugin.prompt.set(`${ctx.plugin.prompt.get() ?? ""}\n\nacme-marker`);
	},
});
