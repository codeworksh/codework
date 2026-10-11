import { defineConfig } from "vite-plus";

const ignoredPaths = ["dist/**", "**/dist/**", "target/**", "node_modules/**", "**/node_modules/**"];

// The launcher is the npm package; the Rust crate beside it is packaged into the
// platform packages and never touched by the JS build.
export default defineConfig({
	pack: {
		entry: ["src/index.ts"],
		format: ["esm"],
		outDir: "dist/pack",
		sourcemap: true,
		clean: true,
		// A launcher with no importable API; the CLI calls it, it does not type it.
		dts: false,
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
