import { defineConfig } from "vite-plus";

export default defineConfig({
	lint: {
		ignorePatterns: ["dist/**", "node_modules/**"],
		options: {
			typeAware: true,
			typeCheck: true,
		},
	},
});
