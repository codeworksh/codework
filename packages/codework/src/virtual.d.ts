/** The shared-module registry `scripts/bundle.mjs` generates for the standalone binary. */
declare module "virtual:codework-shared" {
	import type { Plugin } from "@codeworksh/harness/effect";

	const shared: Readonly<Record<string, Plugin.SharedRegistry>>;
	export default shared;
}
