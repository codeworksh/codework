import { define } from "../../../src/plugin/plugin.ts";
// A plugin whose setup explodes: the host must attribute the failure to its id.
export default define({
	id: "acme.setup.throws",
	setup() {
		throw new Error("acme setup exploded");
	},
});
