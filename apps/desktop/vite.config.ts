import { defineConfig } from "vite-plus";

// The main process is bundled to CJS; only `electron` (and Node built-ins)
// stay external — everything else is inlined into the artifact.
const isExternal = (id: string) => id === "electron" || id.startsWith("electron/") || id.startsWith("node:");

export default defineConfig({
	pack: [
		{
			format: "cjs",
			outDir: "out",
			dts: false,
			sourcemap: true,
			outExtensions: () => ({ js: ".cjs" }),
			entry: ["src/main.ts", "src/preload.ts"],
			clean: true,
			deps: {
				neverBundle: isExternal,
			},
		},
	],
});
