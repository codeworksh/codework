import { define } from "../../../src/plugin/plugin.ts";
// Intentionally bypasses the type contract to verify runtime validation.
export default define({
	id: "acme.tool.malformed",
	setup(ctx) {
		// @ts-expect-error Deliberately malformed registration must fail at runtime.
		ctx.plugin.tools.add({ definition: { name: "not_a_tool" } });
	},
});
