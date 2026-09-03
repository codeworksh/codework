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
];

// The CLI ships as a single self-contained binary, so every workspace package it
// depends on is resolved from source and inlined by `pack` (see `deps.alwaysBundle`).
const aliases = {
	"@codeworksh/harness/sandbox": fileURLToPath(new URL("../harness/src/sandbox.ts", import.meta.url)),
	"@codeworksh/harness/effect": fileURLToPath(new URL("../harness/src/effect.ts", import.meta.url)),
	"@codeworksh/harness": fileURLToPath(new URL("../harness/src/index.ts", import.meta.url)),
	"@codeworksh/aikit/modelgen": fileURLToPath(new URL("../aikit/src/modelgen.ts", import.meta.url)),
	"@codeworksh/aikit/failure": fileURLToPath(new URL("../aikit/src/llm/failure.ts", import.meta.url)),
	"@codeworksh/aikit": fileURLToPath(new URL("../aikit/src/index.ts", import.meta.url)),
	"@codeworksh/utils": fileURLToPath(new URL("../utils/src/index.ts", import.meta.url)),
};
const bundledWorkspaceDeps = ["@codeworksh/harness", "@codeworksh/aikit", "@codeworksh/utils"];

export default defineConfig({
	resolve: {
		alias: aliases,
	},
	pack: {
		entry: ["src/index.ts"],
		format: ["esm"],
		outDir: "dist/pack",
		deps: {
			alwaysBundle: bundledWorkspaceDeps,
			dts: {
				alwaysBundle: bundledWorkspaceDeps,
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
		include: ["test/**/*.test.ts"],
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
