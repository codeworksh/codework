import { defineConfig } from "bumpp";

// Release config for @codeworksh/aikit, loaded automatically by `bumpp`.
// - Tags follow the repo's `<pkg>@v<version>` convention.
// - Pushing stays manual; publishing runs in CI (.github/workflows/publish.yml).
export default defineConfig({
	tag: "aikit@v%s",
	commit: "release: aikit@v%s",
	push: false,
});
