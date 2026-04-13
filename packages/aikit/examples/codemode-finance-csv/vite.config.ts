import { defineConfig } from "vite-plus";

const ignoredPaths = ["dist/**", "node_modules/**"];

export default defineConfig({
	lint: {
		ignorePatterns: ignoredPaths,
		options: {
			typeAware: true,
			typeCheck: true,
		},
	},
	fmt: {
		ignorePatterns: ignoredPaths,
		printWidth: 120,
		useTabs: true,
		tabWidth: 3,
	},
	pack: {
		entry: ["src/index.ts"],
		format: ["esm"],
		sourcemap: true,
		clean: true,
		dts: false,
		outDir: "dist",
	},
});
