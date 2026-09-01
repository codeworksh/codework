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
	".vercel/**",
	"**/.vercel/**",
];
const aliases = {
	"@codeworksh/aikit/failure": fileURLToPath(new URL("./packages/aikit/src/llm/failure.ts", import.meta.url)),
	"@codeworksh/aikit": fileURLToPath(new URL("./packages/aikit/src/index.ts", import.meta.url)),
	"@codeworksh/harness": fileURLToPath(new URL("./packages/harness/src/index.ts", import.meta.url)),
	"@codeworksh/utils": fileURLToPath(new URL("./packages/utils/src/index.ts", import.meta.url)),
};

const harnessRules = {
	...recommended.rules,
	// Harness has explicit Node host/provider boundaries; the package's Effect
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
	},
	lint: {
		// Effect rules from @effect/tsgo, scoped to the only Effect codebase here -- aikit and
		// utils are plain TypeScript and would drown in false positives. Overrides cannot
		// `extends`, so the preset's plugins/rules are spread in directly. These need Oxlint's
		// type-aware mode, which the patched oxlint-tsgolint binary provides (`prepare`).
		overrides: [
			{
				files: ["packages/harness/src/**/*.ts"],
				...(recommended.plugins && { plugins: recommended.plugins }),
				rules: harnessRules,
			},
		],
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
