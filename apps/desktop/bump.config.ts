import { defineConfig } from "bumpp";

// Release config for the desktop app, loaded automatically by `bumpp`. Its version is its own;
// canary and dev builds add their run id to it as the npm packages do.
export default defineConfig({
	tag: "@codeworksh/desktop@%s",
	commit: "release: @codeworksh/desktop@%s",
	push: false,
});
