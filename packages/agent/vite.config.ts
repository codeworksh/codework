import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const ignoredPaths = ["dist/**", "**/dist/**", "node_modules/**", "**/node_modules/**", ".pnpm-store/**", ".zed/**"];
const aliases = {
	"@codeworksh/sdk": fileURLToPath(new URL("../sdk/src/index.ts", import.meta.url)),
};

export default defineConfig({
	resolve: {
		alias: aliases,
	},
	pack: {
		entry: ["src/index.ts"],
		format: ["esm"],
		outDir: "dist/pack",
		deps: {
			alwaysBundle: ["@codeworksh/sdk", "@codeworksh/utils"],
			onlyBundle: ["@sinclair/typebox", "balanced-match", "brace-expansion", "glob", "minimatch"],
		},
		sourcemap: true,
		clean: true,
		dts: {
			resolver: "tsc",
		},
	},
	test: {
		include: ["test/**/*.test.ts", "tests/**/*.test.ts"],
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
