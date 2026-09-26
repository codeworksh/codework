import { recommended } from "@effect/tsgo/oxlint-presets";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { configDefaults } from "vite-plus/test/config";

const ignoredPaths = [
	"dist/**",
	"**/dist/**",
	"node_modules/**",
	"**/node_modules/**",
	".pnpm-store/**",
	".zed/**",
	".vercel/**",
	"**/.vercel/**",
];
const aliases = [
	// `@codeworksh/plugin` is the published plugin SDK; in this repo it resolves to source,
	// so a change to the contract is visible to the harness and the example plugins at once.
	{
		find: /^@codeworksh\/plugin$/,
		replacement: fileURLToPath(new URL("./packages/plugin/src/index.ts", import.meta.url)),
	},
	{
		find: /^@codeworksh\/plugin\/(.*)$/,
		replacement: fileURLToPath(new URL("./packages/plugin/src/$1.ts", import.meta.url)),
	},
	{
		find: "@codeworksh/harness/effect",
		replacement: fileURLToPath(new URL("./packages/harness/src/effect.ts", import.meta.url)),
	},
	{
		find: "@codeworksh/harness/sandbox",
		replacement: fileURLToPath(new URL("./packages/harness/src/sandbox.ts", import.meta.url)),
	},
	{
		find: "@codeworksh/aikit/failure",
		replacement: fileURLToPath(new URL("./packages/aikit/src/llm/failure.ts", import.meta.url)),
	},
	{
		find: "@codeworksh/aikit/modelgen",
		replacement: fileURLToPath(new URL("./packages/aikit/src/modelgen.ts", import.meta.url)),
	},
	{
		find: /^@codeworksh\/aikit\/(oauth\/.+)$/,
		replacement: fileURLToPath(new URL("./packages/aikit/src/$1.ts", import.meta.url)),
	},
	{ find: "@codeworksh/aikit", replacement: fileURLToPath(new URL("./packages/aikit/src/index.ts", import.meta.url)) },
	{
		find: "@codeworksh/harness",
		replacement: fileURLToPath(new URL("./packages/harness/src/index.ts", import.meta.url)),
	},
];

// Packages written against Effect. Kept as a list so lint overrides and the
// Effect rule set stay in one place as more Effect packages land.
const effectPackages = ["packages/harness/src/**/*.ts", "packages/plugin/src/**/*.ts", "packages/codework/src/**/*.ts"];

const effectRules = {
	...recommended.rules,
	// These packages have explicit Node host/provider boundaries; their Effect
	// language-service policy permits these imports for the same reason.
	"effecttsgo/node-builtin-import": "off",
	// These APIs intentionally return fresh streams/layers or perform setup when
	// called. Treating every zero-argument constructor as redundant is incorrect.
	"effecttsgo/lazy-effect": "off",
} as const;

export default defineConfig({
	resolve: {
		alias: aliases,
	},
	test: {
		include: ["packages/**/*.test.ts"],
		exclude:
			process.env.CODEWORK_SANDBOX_E2E_REQUIRED === "1"
				? configDefaults.exclude
				: [...configDefaults.exclude, "packages/**/*.e2e.test.ts"],
	},
	lint: {
		// Effect rules from @effect/tsgo, scoped to the Effect codebases here -- aikit
		// is plain TypeScript and would drown in false positives. Overrides cannot
		// `extends`, so the preset's plugins/rules are spread in directly. These need Oxlint's
		// type-aware mode, which the patched oxlint-tsgolint binary provides (`prepare`).
		overrides: [
			{
				files: effectPackages,
				...(recommended.plugins && { plugins: recommended.plugins }),
				rules: effectRules,
			},
		],
		ignorePatterns: ignoredPaths,
		options: {
			typeAware: true,
			typeCheck: true,
		},
	},
	fmt: {
		// A file snapshot is the exact bytes a test wrote; reformatting it would make it drift.
		ignorePatterns: [...ignoredPaths, "**/__artifacts__/**"],
		printWidth: 120,
		useTabs: true,
		tabWidth: 3,
		sortPackageJson: true,
	},
});
