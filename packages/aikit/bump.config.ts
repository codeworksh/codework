import { defineConfig } from "bumpp";

// Release config for @codeworksh/aikit, loaded automatically by `bumpp`.
// - Tags follow the repo's `@codeworksh/<pkg>@<version>` convention.
// - Pushing and publishing stay manual: run `pnpm bump` (here or `pnpm bump:aikit`
//   from root), push the commit + tag, then `pnpm release` / `pnpm release:aikit`.
export default defineConfig({
	tag: "@codeworksh/aikit@%s",
	commit: "release: @codeworksh/aikit@%s",
	push: false,
});
