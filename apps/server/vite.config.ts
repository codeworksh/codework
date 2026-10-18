import { defineConfig } from "vite-plus";

// Electron runs this bundle as a Node process (ELECTRON_RUN_AS_NODE). A packaged app ships it
// without node_modules, so every dependency, workspace packages included, is inlined.
export default defineConfig({
	pack: [
		{
			format: "esm",
			outDir: "dist",
			dts: false,
			sourcemap: true,
			entry: ["src/index.ts"],
			clean: true,
			platform: "node",
			deps: {
				alwaysBundle: [/^(?!node:)/],
				onlyBundle: false,
			},
		},
	],
	test: {
		include: ["test/**/*.test.ts"],
	},
});
