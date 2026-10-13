import { defineConfig } from "bumpp";

// Release config for @codeworksh/tui, loaded automatically by `bumpp`. The platform
// packages ship in lockstep with the launcher, so all four versions move together.
export default defineConfig({
	files: ["package.json", "npm/*/package.json"],
	tag: "@codeworksh/tui@%s",
	commit: "release: @codeworksh/tui@%s",
	push: false,
});
