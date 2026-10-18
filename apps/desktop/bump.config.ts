import { defineConfig } from "bumpp";

// Release config for the desktop app, loaded automatically by `bumpp`. Its version is its own;
// canary and dev builds add their run id to it as the npm packages do.
export default defineConfig({
	tag: "desktop@v%s",
	commit: "release: desktop@v%s",
	push: false,
});
