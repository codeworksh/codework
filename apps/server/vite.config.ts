import { defineConfig } from "vite-plus";

// Electron runs this bundle as a Node process (ELECTRON_RUN_AS_NODE), resolving
// dependencies from node_modules beside it, so they stay external.
export default defineConfig({
	pack: [
		{
			format: "esm",
			outDir: "dist",
			dts: false,
			sourcemap: true,
			entry: ["src/index.ts"],
			clean: true,
		},
	],
});
