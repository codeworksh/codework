import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { HOME_CHANNEL, PICK_FOLDER_CHANNEL, REVEAL_CHANNEL } from "./ipc.ts";
import { startServer } from "./server.ts";

const SCHEME = app.isPackaged ? "codework" : "codework-dev";
const HOST = "app";
const APP_URL = `${SCHEME}://${HOST}/`;

// When set (web dev server), the scheme proxies to it; otherwise the bundled
// `@codeworksh/web` build is served from disk: the app's Resources when packaged,
// else the workspace beside this app.
const DEV_SERVER_URL = process.env.CODEWORK_WEB_URL;
const CLIENT_ASSETS_DIR =
	process.env.CODEWORK_WEB_DIR ??
	(app.isPackaged ? path.join(process.resourcesPath, "web") : path.resolve(app.getAppPath(), "../web/dist"));
// The 3D brand mark on Apple's icon grid. A packaged build carries it as an .icns; an unpackaged run
// sets it at runtime, or the Dock shows Electron's own icon.
const ICON = path.join(app.getAppPath(), "resources/icon.png");

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
		// Module scripts carry `Origin: codework-dev://app`; forwarding it makes
		// net.fetch a CORS request the dev server never allows, failing every script.
		const headers = new Headers(request.headers);
		headers.delete("origin");
		return net.fetch(new URL(`${url.pathname}${url.search}`, DEV_SERVER_URL).toString(), {
			method: request.method,
			headers,
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
		// Wider than the web app's 768px narrow breakpoint, so the sidebar always sits beside the content.
		minWidth: 840,
		minHeight: 620,
		// The web shell draws its own title bar (workspace switcher) beside the
		// inset traffic lights, which sit centered in its 40px height.
		...(process.platform === "darwin" && {
			titleBarStyle: "hiddenInset",
			trafficLightPosition: { x: 14, y: 14 },
		}),
		// Windows and Linux take the window's icon; macOS ignores it for the Dock's.
		icon: ICON,
		// The default File/Edit menu bar shows until Alt; its shortcuts work either way.
		autoHideMenuBar: true,
		// Hidden until the page's first paint, the splash in the saved theme, so it never opens blank.
		show: false,
		webPreferences: {
			preload: path.join(app.getAppPath(), "out/preload.cjs"),
			sandbox: true,
			// A hidden window's renderer is throttled, which holds up the first paint that shows it.
			backgroundThrottling: false,
		},
	});
	const reveal = () => {
		window.show();
		window.webContents.setBackgroundThrottling(true);
	};
	window.once("ready-to-show", reveal);
	// Linux can miss ready-to-show; the load finishing reveals the window there.
	if (process.platform === "linux") window.webContents.once("did-finish-load", reveal);
	// Links that open a new window, as a reply's links do, open in the browser instead.
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith("https:") || url.startsWith("http:")) void shell.openExternal(url);
		return { action: "deny" };
	});
	void window.loadURL(APP_URL);
	return window;
}

// A second launch (the Start menu, a .desktop file) would start a second app server on the same
// database, so it focuses the running app's window instead.
if (!app.requestSingleInstanceLock()) app.exit();
app.on("second-instance", () => {
	const window = BrowserWindow.getAllWindows()[0];
	if (window === undefined) return;
	if (window.isMinimized()) window.restore();
	window.focus();
});

// The installer's shortcuts carry the app id, and Windows groups the taskbar button with the
// shortcut whose id the running app takes.
if (process.platform === "win32" && app.isPackaged) {
	const { appId } = JSON.parse(readFileSync(path.join(app.getAppPath(), "package.json"), "utf8")) as { appId: string };
	app.setAppUserModelId(appId);
}

void app.whenReady().then(async () => {
	// A packaged app's Info.plist names its icon; setting it again would replace one the user chose.
	if (!app.isPackaged) app.dock?.setIcon(ICON);
	protocol.handle(SCHEME, handleRequest);
	ipcMain.on(HOME_CHANNEL, (event) => {
		event.returnValue = app.getPath("home");
	});
	ipcMain.handle(PICK_FOLDER_CHANNEL, async (event, from: string) => {
		const options: Electron.OpenDialogOptions = {
			defaultPath: from,
			properties: ["openDirectory", "createDirectory"],
		};
		// Attached to the window, so on macOS it drops down as a sheet.
		const window = BrowserWindow.fromWebContents(event.sender);
		const result = await (window === null ? dialog.showOpenDialog(options) : dialog.showOpenDialog(window, options));
		return result.canceled ? null : (result.filePaths[0] ?? null);
	});
	ipcMain.handle(REVEAL_CHANNEL, (_event, file: string) => shell.showItemInFolder(file));
	await startServer();
	createMainWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

// A signal (the dev runner restarting, a terminal's Ctrl+C) quits as the app does, so the app server
// is stopped too; left to the default, Electron would exit at once and leave it running.
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => app.quit());
