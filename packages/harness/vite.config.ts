import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const ignoredPaths = [
	"dist/**",
	"**/dist/**",
	"node_modules/**",
	"**/node_modules/**",
	".pnpm-store/**",
	".zed/**",
	".idea/**",
	".vscode/**",
];
const aliases = {
	"@codeworksh/utils": fileURLToPath(new URL("../utils/src/index.ts", import.meta.url)),
	"@codeworksh/aikit": fileURLToPath(new URL("../aikit/src/index.ts", import.meta.url)),
};

export default defineConfig({
	resolve: {
		alias: aliases,
	},
	pack: {
		entry: ["src/index.ts", "src/harness/codemode/drivers/drivers.ts"],
		format: ["esm"],
		outDir: "dist/pack",
		deps: {
			alwaysBundle: ["@codeworksh/utils", "@codeworksh/aikit"],
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
