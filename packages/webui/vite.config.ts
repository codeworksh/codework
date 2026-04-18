import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";

const port = Number(process.env.PORT ?? 5733);
const host = process.env.HOST?.trim() || "127.0.0.1";

export default defineConfig({
	plugins: [tanstackRouter(), react()],
	server: {
		host,
		port,
		strictPort: true,
		hmr: {
			host,
			protocol: "ws",
		},
	},
	build: {
		outDir: fileURLToPath(new URL("../desktop/dist/renderer", import.meta.url)),
		emptyOutDir: true,
		sourcemap: true,
	},
});
