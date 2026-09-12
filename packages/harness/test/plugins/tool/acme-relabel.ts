import { define } from "../../../src/plugin/plugin.ts";
// Patches prose on a tool someone else owns, without touching its handler or hooks.
export default define({
	id: "acme.tool.relabel",
	setup(ctx) {
		ctx.plugin.tools.update("acme_echo", { description: "Echo, relabelled by acme" });
	},
});
