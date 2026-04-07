import { builtinModules } from "node:module";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const repoRoot = fileURLToPath(new URL("./", import.meta.url));
const workspaceEntries = {
	aikit: fileURLToPath(new URL("./packages/aikit/src/index.ts", import.meta.url)),
	utils: fileURLToPath(new URL("./packages/utils/src/index.ts", import.meta.url)),
};
const workspaceDir = relative(repoRoot, process.cwd()).replaceAll("\\", "/");
const packEntries =
	workspaceDir === "packages/aikit"
		? [workspaceEntries.aikit]
		: workspaceDir === "packages/utils"
			? [workspaceEntries.utils]
			: Object.values(workspaceEntries);

const external = (id: string) =>
	builtinModules.includes(id) ||
	builtinModules.some((moduleName) => id === `node:${moduleName}`) ||
	(!id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0"));

export default defineConfig({
	build: {
		lib: {
			entry: workspaceEntries,
			formats: ["es"],
		},
		outDir: "dist/build",
		sourcemap: true,
		rollupOptions: {
			external,
		},
	},
	test: {
		include: ["packages/**/*.test.ts"],
	},
	lint: {
		ignorePatterns: ["dist/**", "node_modules/**", ".pnpm-store/**", ".zed/**"],
		options: {
			typeAware: true,
			typeCheck: true,
		},
	},
	fmt: {
		ignorePatterns: ["dist/**", "node_modules/**", ".pnpm-store/**", ".zed/**"],
		printWidth: 120,
		useTabs: true,
		tabWidth: 3,
		sortPackageJson: true,
	},
	pack: {
		entry: packEntries,
		format: ["esm"],
		dts: true,
		sourcemap: true,
		clean: true,
		outDir: "dist/pack",
	},
});
