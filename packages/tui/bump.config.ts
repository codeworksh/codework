import { defineConfig } from "bumpp";

// Release config for @codeworksh/tui, loaded automatically by `bumpp`. The platform
// packages ship in lockstep with the launcher, so all four versions move together.
export default defineConfig({
	files: ["package.json", "npm/*/package.json"],
	tag: "tui@v%s",
	commit: "release: tui@v%s",
	push: false,
});
