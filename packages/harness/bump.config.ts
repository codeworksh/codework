import { defineConfig } from "bumpp";

// Release config for @codeworksh/harness, loaded automatically by `bumpp`.
// Pushing and publishing stay manual so prerelease validation can happen first.
export default defineConfig({
	tag: "@codeworksh/harness@%s",
	commit: "release: @codeworksh/harness@%s",
	push: false,
});
