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
};

export default defineConfig({
	resolve: {
		alias: aliases,
	},
	pack: {
		entry: ["src/index.ts", "src/cli.ts", "src/oauth/openai/codex.ts"],
		format: ["esm"],
		outDir: "dist/pack",
		deps: {
			alwaysBundle: ["@codeworksh/utils"],
		},
		sourcemap: true,
		clean: true,
		dts: {
			resolver: "tsc",
		},
	},
	test: {
		// Unit tests live in test/; live-provider suites live in test/e2e/.
		// `pnpm test` excludes test/e2e (see package.json) so the default run is
		// deterministic and free; `pnpm test:e2e` runs both since the API suites
		// call paid providers.
		include: ["test/**/*.test.ts", "tests/**/*.test.ts"],
		env: {
			CODEWORK_MODELS_FILE: fileURLToPath(new URL("../../models.gen.json", import.meta.url)),
		},
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
