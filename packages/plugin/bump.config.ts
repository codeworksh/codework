import { defineConfig } from "bumpp";

// Release config for @codeworksh/plugin, loaded automatically by `bumpp`.
// Pushing and publishing stay manual so prerelease validation can happen first.
export default defineConfig({
	tag: "plugin@v%s",
	commit: "release: plugin@v%s",
	push: false,
});
