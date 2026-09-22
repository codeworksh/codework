import { defineConfig } from "bumpp";

// Release config for @codeworksh/plugin, loaded automatically by `bumpp`.
// Pushing and publishing stay manual so prerelease validation can happen first.
export default defineConfig({
	tag: "@codeworksh/plugin@%s",
	commit: "release: @codeworksh/plugin@%s",
	push: false,
});
