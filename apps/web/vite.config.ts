import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
	plugins: [
		// Route components load as split chunks so feature code stays out of the
		// cold-start payload; the router prefetches them on navigation intent.
		tanstackRouter({ autoCodeSplitting: true }),
		react(),
	],
});
