// A plugin whose setup explodes: the host must attribute the failure to its id.
export default {
	id: "acme.setup.throws",
	setup() {
		throw new Error("acme setup exploded");
	},
};
