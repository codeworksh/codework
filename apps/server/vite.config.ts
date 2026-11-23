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
		projects: [
			{
				extends: true,
				test: { name: "server", include: ["test/**/*.test.ts"], exclude: ["test/**/*.live.test.ts"] },
			},
			// The live suites share the OrbStack machines, and each start stops the server another one runs.
			{ extends: true, test: { name: "live", include: ["test/**/*.live.test.ts"], fileParallelism: false } },
		],
	},
});
