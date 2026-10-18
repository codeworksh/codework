import { defineConfig } from "bumpp";

// Release config for @codeworksh/codework, loaded automatically by `bumpp`.
// Pushing and publishing stay manual so prerelease validation can happen first.
export default defineConfig({
	tag: "cli@v%s",
	commit: "release: cli@v%s",
	push: false,
});
