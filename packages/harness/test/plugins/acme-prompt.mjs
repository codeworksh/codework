// Single-file prompt plugin: composes on whatever an earlier prompt plugin set.
export default {
	id: "acme.prompt.marker",
	setup(ctx) {
		ctx.plugin.prompt.set(`${ctx.plugin.prompt.get() ?? ""}\n\nacme-marker`);
	},
};
