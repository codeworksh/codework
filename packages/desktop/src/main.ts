import { app, BrowserWindow, ipcMain, nativeTheme, shell } from "electron";
import { join } from "node:path";
import type { DesktopAppBranding } from "@codeworksh/bridge";
import { resolveDesktopAppBranding} from "./branding.ts";
import { resolveDesktopRuntimeInfo} from "./arch.ts";

// channel
const GET_APP_BRANDING_CHANNEL = "desktop:get-app-branding";

const devServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
const isDevelopment = Boolean(devServerUrl);
const rendererIndexPath = join(__dirname, "..", "renderer", "index.html");

const desktopAppBranding: DesktopAppBranding = resolveDesktopAppBranding({
	isDevelopment,
	appVersion: app.getVersion(),
});
const APP_DISPLAY_NAME = desktopAppBranding.displayName;


const desktopRuntimeInfo = resolveDesktopRuntimeInfo({
	platform: process.platform,
	processArch: process.arch,
	runningUnderArm64Translation: app.runningUnderARM64Translation,
});

function registerIpcHandlers(): void {
	ipcMain.removeAllListeners(GET_APP_BRANDING_CHANNEL);

	ipcMain.on(GET_APP_BRANDING_CHANNEL, (event) => {
		event.returnValue = desktopAppBranding;
	});
}

function getInitialWindowBackgroundColor(): string {
	return nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff";
}

function syncWindowAppearance(window: BrowserWindow): void {
	if (window.isDestroyed()) {
		return;
	}

	window.setBackgroundColor(getInitialWindowBackgroundColor());
}

function syncAllWindowAppearance(): void {
	for (const window of BrowserWindow.getAllWindows()) {
		syncWindowAppearance(window);
	}
}

nativeTheme.on("updated", syncAllWindowAppearance);

function createWindow(): BrowserWindow {
	const window = new BrowserWindow({
		width: 1100,
		height: 780,
		minWidth: 840,
		minHeight: 620,
		show: false,
		autoHideMenuBar: true,
		backgroundColor: getInitialWindowBackgroundColor(),
		title: APP_DISPLAY_NAME,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			preload: join(__dirname, "preload.cjs"),
		},
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		void shell.openExternal(url);
		return { action: "deny" };
	});

	window.on("page-title-updated", (event) => {
		event.preventDefault();
		window.setTitle(APP_DISPLAY_NAME);
	});

	window.once("ready-to-show", () => {
		window.show();
	});

	window.webContents.on("did-finish-load", () => {
		window.setTitle(APP_DISPLAY_NAME);
	});

	if (isDevelopment) {
		void window.loadURL(devServerUrl as string);
		window.webContents.openDevTools({ mode: "detach" });
		return window;
	}

	void window.loadFile(rendererIndexPath);
	return window;
}

void app.whenReady().then(() => {
	registerIpcHandlers();
	createWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
});

void app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});
