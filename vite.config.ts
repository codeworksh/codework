import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const ignoredPaths = ["dist/**", "**/dist/**", "node_modules/**", "**/node_modules/**", ".pnpm-store/**", ".zed/**"];
const aliases = {
	"@codeworksh/aikit": fileURLToPath(new URL("./packages/aikit/src/index.ts", import.meta.url)),
	"@codeworksh/aikit/codemode/drivers": fileURLToPath(
		new URL("./packages/aikit/src/agent/codemode/drivers/drivers.ts", import.meta.url),
	),
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
