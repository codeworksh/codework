import { defineConfig } from "bumpp";

// Release config for @codeworksh/aikit, loaded automatically by `bumpp`.
// - Tags follow the repo's `@codeworksh/<pkg>@<version>` convention.
// - Pushing stays manual; publishing runs in CI (.github/workflows/publish.yml).
export default defineConfig({
	tag: "@codeworksh/aikit@%s",
	commit: "release: @codeworksh/aikit@%s",
	push: false,
});
