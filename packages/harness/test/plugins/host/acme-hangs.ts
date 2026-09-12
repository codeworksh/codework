import { define } from "../../../src/plugin/plugin.ts";
// A setup that never settles: only interruption can end the exchange it blocks.
export default define({
	id: "acme.setup.hangs",
	setup: () => new Promise<void>(() => {}),
});
