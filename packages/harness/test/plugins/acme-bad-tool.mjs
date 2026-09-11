// Registers a malformed tool (no schemas, no handler) — untyped JS can reach here.
export default {
	id: "acme.tool.malformed",
	setup(ctx) {
		ctx.plugin.tools.add({ definition: { name: "not_a_tool" } });
	},
};
