import { defineConfig } from "vite-plus";

const ignoredPaths = ["dist/**", "**/dist/**", "node_modules/**", "**/node_modules/**", ".pnpm-store/**", ".zed/**"];

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts", "tests/**/*.test.ts"],
	},
	pack: {
		entry: ["src/index.ts"],
		format: ["esm"],
		dts: true,
		sourcemap: true,
		clean: true,
		outDir: "dist/pack",
	},
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
		sortPackageJson: true,
	},
});
