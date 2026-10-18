import { defineConfig } from "bumpp";

// Release config for @codeworksh/harness, loaded automatically by `bumpp`.
// Pushing and publishing stay manual so prerelease validation can happen first.
export default defineConfig({
	tag: "harness@v%s",
	commit: "release: harness@v%s",
	push: false,
});
