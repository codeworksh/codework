import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
	plugins: [
		// Route components load as split chunks so feature code stays out of the
		// cold-start payload; the router prefetches them on navigation intent.
		tanstackRouter({ autoCodeSplitting: true }),
		react({ compiler: true }),
		tailwindcss(),
	],
	// shadcn components import through "@/"; tsconfig.json declares the same alias.
	resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
	// The repo root's .env.local supplies the Clerk publishable key and, in development, the relay URL.
	// The prefixes admit only those public values, never CLERK_SECRET_KEY or any other secret.
	envDir: fileURLToPath(new URL("../..", import.meta.url)),
	envPrefix: ["VITE_", "CLERK_PUBLISHABLE_KEY", "CODEWORK_RELAY_URL"],
	// The diff highlighter's worker loads grammars on demand, which a classic worker bundle cannot split.
	worker: { format: "es" },
	// Pinned so the desktop shell can proxy to a fixed address; `localhost`
	// may bind IPv6-only, which Electron's 127.0.0.1 lookup then misses.
	server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
