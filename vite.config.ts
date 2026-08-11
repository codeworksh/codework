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
	"@codeworksh/aikit": fileURLToPath(new URL("./packages/aikit/src/index.ts", import.meta.url)),
	"@codeworksh/harness": fileURLToPath(new URL("./packages/harness/src/index.ts", import.meta.url)),
	"@codeworksh/utils": fileURLToPath(new URL("./packages/utils/src/index.ts", import.meta.url)),
};

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
				...(recommended.rules && { rules: recommended.rules }),
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
