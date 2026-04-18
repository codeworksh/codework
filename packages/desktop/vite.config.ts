import { defineConfig } from "vite-plus";

export default defineConfig({
	pack: {
		entry: ["src/main.ts", "src/preload.ts"],
		format: ["cjs"],
		outDir: "dist/electron",
		sourcemap: true,
		clean: true,
		outExtensions: () => ({ js: ".cjs" }),
		dts: false,
	},
	lint: {
		ignorePatterns: ["dist/**", "node_modules/**"],
		options: {
			typeAware: true,
			typeCheck: true,
		},
	},
});
