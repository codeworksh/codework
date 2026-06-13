import { defineConfig } from "bumpp";

// Release config for @codeworksh/sdk, loaded automatically by `bumpp`.
// - Tags follow the repo's `@codeworksh/<pkg>@<version>` convention.
// - Pushing and publishing stay manual: run `pnpm bump` (here or `pnpm bump:sdk`
//   from root), push the commit + tag, then `pnpm release` / `pnpm release:sdk`.
export default defineConfig({
	tag: "@codeworksh/sdk@%s",
	commit: "release: @codeworksh/sdk@%s",
	push: false,
});
