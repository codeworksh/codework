import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const ignoredPaths = ["dist/**", "**/dist/**", "node_modules/**", "**/node_modules/**", ".pnpm-store/**", ".zed/**"];
const aliases = {
	"@codeworksh/utils": fileURLToPath(new URL("../utils/src/index.ts", import.meta.url)),
};

export default defineConfig({
	resolve: {
		alias: aliases,
	},
	test: {
		include: ["test/**/*.test.ts", "tests/**/*.test.ts"],
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
	pack: {
		entry: ["src/index.ts", "src/agent/codemode/drivers/drivers.ts"],
		format: ["esm"],
		dts: true,
		sourcemap: true,
		clean: true,
		outDir: "dist/pack",
	},
});
