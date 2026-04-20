import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import pkg from "./package.json" with { type: "json" };

const port = Number(process.env.PORT ?? 5733);
const host = process.env.HOST?.trim() || "127.0.0.1";
const configuredHttpUrl = process.env.VITE_HTTP_URL?.trim();
const sourcemapEnv = process.env.CODEWORK_WEBUI_SOURCEMAP?.trim().toLowerCase();

const buildSourcemap =
	sourcemapEnv === "0" || sourcemapEnv === "false" ? false : sourcemapEnv === "hidden" ? "hidden" : true;

export default defineConfig({
	plugins: [tanstackRouter(), react(), tailwindcss()],
	define: {
		"import.meta.env.VITE_HTTP_URL": JSON.stringify(configuredHttpUrl ?? ""),
		"import.meta.env.APP_VERSION": JSON.stringify(pkg.version),
	},
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
		sourcemap: buildSourcemap,
	},
});
