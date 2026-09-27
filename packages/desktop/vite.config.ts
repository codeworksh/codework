import { recommended } from "@effect/tsgo/oxlint-presets";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const ignoredPaths = [
	"dist/**",
	"**/dist/**",
	"out/**",
	"node_modules/**",
	"**/node_modules/**",
	".pnpm-store/**",
	".zed/**",
	".idea/**",
	".vscode/**",
];

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

const pluginAliases = [
	{ find: /^@codeworksh\/plugin$/, replacement: fileURLToPath(new URL("../plugin/src/index.ts", import.meta.url)) },
	{ find: /^@codeworksh\/plugin\/(.*)$/, replacement: fileURLToPath(new URL("../plugin/src/$1.ts", import.meta.url)) },
	...Object.entries(aliases).map(([find, replacement]) => ({ find, replacement })),
];

export default defineConfig({
	resolve: {
		alias: pluginAliases,
	},
	test: {
		include: ["test/**/*.test.ts"],
		env: {
			CODEWORK_MODELS_FILE: fileURLToPath(new URL("../../models.gen.json", import.meta.url)),
		},
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
		ignorePatterns: [...ignoredPaths, "**/__artifacts__/**"],
		printWidth: 120,
		useTabs: true,
		tabWidth: 3,
		sortPackageJson: true,
	},
});
