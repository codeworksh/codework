import { fileURLToPath } from "node:url";
import { recommended } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "vite-plus";

const ignoredPaths = ["dist/**", "**/dist/**", "node_modules/**", "**/node_modules/**", ".pnpm-store/**"];
const aliases = {
	"@codeworksh/aikit/modelgen": fileURLToPath(new URL("../aikit/src/modelgen.ts", import.meta.url)),
	"@codeworksh/aikit/failure": fileURLToPath(new URL("../aikit/src/llm/failure.ts", import.meta.url)),
	"@codeworksh/aikit": fileURLToPath(new URL("../aikit/src/index.ts", import.meta.url)),
};

export default defineConfig({
	resolve: {
		alias: aliases,
	},
	pack: {
		// Every subpath in `exports`. A plugin author imports one or two of these; the harness
		// imports most of them, which is the point — both sides load the same modules.
		entry: [
			"src/event.ts",
			"src/ids.ts",
			"src/index.ts",
			"src/location.ts",
			"src/plugin.ts",
			"src/plugin/prompt.ts",
			"src/plugin/tool.ts",
			"src/posix.ts",
			"src/project.ts",
			"src/repo.ts",
			"src/sandbox.ts",
			"src/sandbox/driver.ts",
			"src/sandbox/errors.ts",
			"src/sandbox/filesystem.ts",
			"src/sandbox/instance.ts",
			"src/sandbox/io.ts",
			"src/sandbox/resource.ts",
			"src/sandbox/shell.ts",
			"src/schema.ts",
			"src/settings.ts",
			"src/space.ts",
			"src/tool.ts",
			"src/tool/error.ts",
			"src/tool/progress.ts",
		],
		format: ["esm"],
		outDir: "dist/pack",
		deps: {
			dts: {
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
