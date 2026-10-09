import { defineConfig } from "vite-plus";

// The main process is bundled to CJS; only `electron` (and Node built-ins)
// stay external — everything else is inlined into the artifact.
const isExternal = (id: string) => id === "electron" || id.startsWith("electron/") || id.startsWith("node:");

// One config per entry: a sandboxed preload cannot require sibling files, so
// modules shared with main must be inlined rather than split into a chunk.
// Neither cleans the shared out dir, or one build would delete the other's file.
const bundle = (entry: string) => ({
	format: "cjs" as const,
	outDir: "out",
	dts: false,
	sourcemap: true,
	outExtensions: () => ({ js: ".cjs" }),
	entry: [entry],
	clean: false,
	deps: {
		neverBundle: isExternal,
	},
});

export default defineConfig({
	pack: [bundle("src/main.ts"), bundle("src/preload.ts")],
});
