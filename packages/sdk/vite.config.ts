import { defineConfig } from "vite-plus";

const ignoredPaths = ["dist/**", "**/dist/**", "node_modules/**", "**/node_modules/**", ".pnpm-store/**", ".zed/**"];

export default defineConfig({
	pack: {
		entry: ["src/index.ts"],
		format: ["esm"],
		outDir: "dist/pack",
		sourcemap: true,
		clean: true,
		dts: {
			tsgo: true,
			resolver: "tsc",
		},
		exports: true,
	},
	test: {
		include: ["test/**/*.test.ts", "tests/**/*.test.ts"],
	},
	lint: {
		ignorePatterns: [...ignoredPaths, "src/generated/**", "**/src/generated/**", "packages/sdk/src/generated/**"],
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
