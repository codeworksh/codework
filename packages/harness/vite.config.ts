import { fileURLToPath } from "node:url";
import { recommended } from "@effect/tsgo/oxlint-presets";
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
	".vercel/**",
	"**/.vercel/**",
];
const aliases = {
	"@codeworksh/utils": fileURLToPath(new URL("../utils/src/index.ts", import.meta.url)),
	"@codeworksh/harness/sandbox": fileURLToPath(new URL("src/sandbox.ts", import.meta.url)),
	"@codeworksh/aikit/modelgen": fileURLToPath(new URL("../aikit/src/modelgen.ts", import.meta.url)),
	"@codeworksh/aikit/failure": fileURLToPath(new URL("../aikit/src/llm/failure.ts", import.meta.url)),
	"@codeworksh/aikit": fileURLToPath(new URL("../aikit/src/index.ts", import.meta.url)),
};

export default defineConfig({
	resolve: {
		alias: aliases,
	},
	pack: {
		entry: [
			"src/index.ts",
			"src/effect.ts",
			"src/sandbox.ts",
			"src/sandboxes/daytona/index.ts",
			"src/sandboxes/vercel/index.ts",
			"src/cli/index.ts",
		],
		format: ["esm"],
		outDir: "dist/pack",
		deps: {
			dts: {
				neverBundle: true,
			},
		},
		sourcemap: true,
		clean: true,
		dts: {
			resolver: "oxc",
			tsconfig: "../../tsconfig.pack.json",
		},
	},
	test: {
		include: ["test/**/*.test.ts", "tests/**/*.test.ts"],
	},
	lint: {
		...recommended,
		ignorePatterns: ignoredPaths,
		options: {
			...recommended.options,
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
