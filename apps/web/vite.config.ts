import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
	plugins: [
		// Route components load as split chunks so feature code stays out of the
		// cold-start payload; the router prefetches them on navigation intent.
		tanstackRouter({ autoCodeSplitting: true }),
		react(),
		tailwindcss(),
	],
	// Pinned so the desktop shell can proxy to a fixed address; `localhost`
	// may bind IPv6-only, which Electron's 127.0.0.1 lookup then misses.
	server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
