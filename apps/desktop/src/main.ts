import { app, BrowserWindow, net, protocol } from "electron";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const SCHEME = app.isPackaged ? "codework" : "codework-dev";
const HOST = "app";
const APP_URL = `${SCHEME}://${HOST}/`;

// When set (web dev server), the scheme proxies to it; otherwise the bundled
// `@codeworksh/web` build is served from disk.
const DEV_SERVER_URL = process.env.CODEWORK_WEB_URL;
const CLIENT_ASSETS_DIR = process.env.CODEWORK_WEB_DIR ?? path.resolve(app.getAppPath(), "../web/dist");

const MIME_TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".ico": "image/x-icon",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".wasm": "application/wasm",
	".map": "application/json",
	".txt": "text/plain",
};

// Must run synchronously before Electron emits `ready`.
protocol.registerSchemesAsPrivileged([
	{
		scheme: SCHEME,
		privileges: {
			standard: true,
			secure: true,
			supportFetchAPI: true,
			corsEnabled: true,
			stream: true,
			codeCache: true,
		},
	},
]);

async function serveAsset(request: Request): Promise<Response> {
	const url = new URL(request.url);
	if (url.host !== HOST) return new Response(null, { status: 404 });
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response(null, { status: 405 });
	}

	const pathname = decodeURIComponent(url.pathname);
	if (pathname.includes("\0")) return new Response(null, { status: 400 });

	const root = path.resolve(CLIENT_ASSETS_DIR);
	const assetPath = path.resolve(root, `.${pathname}`);
	if (assetPath !== root && !assetPath.startsWith(root + path.sep)) {
		return new Response(null, { status: 404 });
	}

	// SPA fallback: unknown paths serve index.html; asset-shaped misses 404.
	let filePath = assetPath;
	const fileStat = await stat(assetPath).catch(() => null);
	if (fileStat?.isFile() !== true) {
		const wantsHtml = request.headers.get("accept")?.includes("text/html") ?? false;
		if (path.extname(assetPath) !== "" && !wantsHtml) {
			return new Response(null, { status: 404 });
		}
		filePath = path.join(root, "index.html");
	}

	const contents = await readFile(filePath).catch(() => null);
	if (contents === null) return new Response(null, { status: 404 });
	return new Response(request.method === "HEAD" ? null : new Uint8Array(contents), {
		headers: {
			"content-type": MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream",
		},
	});
}

function handleRequest(request: Request): Promise<Response> {
	if (DEV_SERVER_URL) {
		const url = new URL(request.url);
		if (url.host !== HOST) return Promise.resolve(new Response(null, { status: 404 }));
		return net.fetch(new URL(`${url.pathname}${url.search}`, DEV_SERVER_URL).toString(), {
			method: request.method,
			headers: request.headers,
			body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
			duplex: "half",
		} as RequestInit);
	}
	return serveAsset(request);
}

function createMainWindow(): BrowserWindow {
	const window = new BrowserWindow({
		width: 1440,
		height: 900,
		webPreferences: {
			preload: path.join(app.getAppPath(), "out/preload.cjs"),
			sandbox: true,
		},
	});
	void window.loadURL(APP_URL);
	return window;
}

void app.whenReady().then(() => {
	protocol.handle(SCHEME, handleRequest);
	createMainWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
