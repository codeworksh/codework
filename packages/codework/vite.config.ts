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

// The CLI ships the harness inside its own bundle, so harness resolves from source
// and is inlined by `pack` (see `deps.alwaysBundle`). Everything harness needs at
// runtime stays external and is declared in this package's dependencies.
const aliases = {
	"@codeworksh/harness/sandbox": fileURLToPath(new URL("../harness/src/sandbox.ts", import.meta.url)),
	"@codeworksh/harness/sandboxes/daytona": fileURLToPath(
		new URL("../harness/src/sandboxes/daytona/index.ts", import.meta.url),
	),
	"@codeworksh/harness/sandboxes/vercel": fileURLToPath(
		new URL("../harness/src/sandboxes/vercel/index.ts", import.meta.url),
	),
	"@codeworksh/harness/effect": fileURLToPath(new URL("../harness/src/effect.ts", import.meta.url)),
	"@codeworksh/harness": fileURLToPath(new URL("../harness/src/index.ts", import.meta.url)),
	"@codeworksh/aikit/modelgen": fileURLToPath(new URL("../aikit/src/modelgen.ts", import.meta.url)),
	"@codeworksh/aikit/failure": fileURLToPath(new URL("../aikit/src/llm/failure.ts", import.meta.url)),
	"@codeworksh/aikit": fileURLToPath(new URL("../aikit/src/index.ts", import.meta.url)),
};
// `@codeworksh/plugin` is the published plugin SDK, resolved to source in this repo so the CLI,
// the harness and the example plugins all compile against one copy of the contract.
const pluginAliases = [
	{ find: /^@codeworksh\/plugin$/, replacement: fileURLToPath(new URL("../plugin/src/index.ts", import.meta.url)) },
	{ find: /^@codeworksh\/plugin\/(.*)$/, replacement: fileURLToPath(new URL("../plugin/src/$1.ts", import.meta.url)) },
	...Object.entries(aliases).map(([find, replacement]) => ({ find, replacement })),
];
const bundledWorkspaceDeps = ["@codeworksh/harness"];

export default defineConfig({
	resolve: {
		alias: pluginAliases,
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
