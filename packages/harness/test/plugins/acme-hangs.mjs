// A setup that never settles: only interruption can end the exchange it blocks.
export default {
	id: "acme.setup.hangs",
	setup: () => new Promise(() => {}),
};
