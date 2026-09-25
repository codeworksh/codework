import { recommended } from "@effect/tsgo/oxlint-presets";
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

// Workspace packages resolve to source here so dev and tests see changes at once. `pack` still
// leaves them external: the published CLI depends on @codeworksh/harness and aikit like any consumer.
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
	"@codeworksh/aikit/oauth/openai/codex": fileURLToPath(
		new URL("../aikit/src/oauth/openai/codex.ts", import.meta.url),
	),
	"@codeworksh/aikit/oauth/github/copilot": fileURLToPath(
		new URL("../aikit/src/oauth/github/copilot.ts", import.meta.url),
	),
	"@codeworksh/aikit/oauth/interactive": fileURLToPath(new URL("../aikit/src/oauth/interactive.ts", import.meta.url)),
	"@codeworksh/aikit/oauth/summary": fileURLToPath(new URL("../aikit/src/oauth/summary.ts", import.meta.url)),
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

export default defineConfig({
	resolve: {
		alias: pluginAliases,
	},
	pack: {
		entry: ["src/index.ts"],
		format: ["esm"],
		outDir: "dist/pack",
		sourcemap: true,
		clean: true,
		// A CLI has no importable API, so no declarations.
		dts: false,
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
