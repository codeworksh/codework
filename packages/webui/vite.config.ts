import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import pkg from "./package.json" with { type: "json" };

const port = Number(process.env.PORT ?? 5733);
const host = process.env.HOST?.trim() || "127.0.0.1";
const configuredHttpUrl = process.env.VITE_HTTP_URL?.trim();
const configuredDevServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
const sourcemapEnv = process.env.CODEWORK_WEBUI_SOURCEMAP?.trim().toLowerCase();

const buildSourcemap =
	sourcemapEnv === "0" || sourcemapEnv === "false" ? false : sourcemapEnv === "hidden" ? "hidden" : true;

function resolveDevRendererOrigin(): URL | null {
	if (configuredDevServerUrl) {
		try {
			return new URL(configuredDevServerUrl);
		} catch {
			return null;
		}
	}

	try {
		return new URL(`http://${host}:${port}`);
	} catch {
		return null;
	}
}

function createDevContentSecurityPolicy(): string | null {
	const devRendererOrigin = resolveDevRendererOrigin();
	if (!devRendererOrigin) {
		return null;
	}

	const websocketProtocol = devRendererOrigin.protocol === "https:" ? "wss:" : "ws:";
	const websocketOrigin = `${websocketProtocol}//${devRendererOrigin.host}`;
	const reactRefreshPreambleHash = createHash("sha256").update(react.preambleCode).digest("base64");

	return [
		"default-src 'self'",
		`script-src 'self' 'sha256-${reactRefreshPreambleHash}'`,
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"font-src 'self' data:",
		`connect-src 'self' ${devRendererOrigin.origin} ${websocketOrigin}`,
	].join("; ");
}

const devContentSecurityPolicy = createDevContentSecurityPolicy();

export default defineConfig(({ command }) => ({
	plugins: [tanstackRouter(), react(), tailwindcss()],
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
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
		headers:
			command === "serve" && devContentSecurityPolicy
				? { "Content-Security-Policy": devContentSecurityPolicy }
				: undefined,
	},
	build: {
		outDir: fileURLToPath(new URL("../desktop/dist/renderer", import.meta.url)),
		emptyOutDir: true,
		sourcemap: buildSourcemap,
	},
}));
