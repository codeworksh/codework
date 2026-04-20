import { app, BrowserWindow, ipcMain, shell } from "electron";
import { join } from "node:path";

const devServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
const isDevelopment = Boolean(devServerUrl);
const getAppInfoChannel = "desktop:get-app-info";
const rendererIndexPath = join(__dirname, "..", "renderer", "index.html");

function registerDesktopIpc(): void {
	ipcMain.handle(getAppInfoChannel, () => ({
		name: app.getName(),
		version: app.getVersion(),
		platform: process.platform,
	}));
}

function createWindow(): void {
	const window = new BrowserWindow({
		width: 1280,
		height: 840,
		minWidth: 1080,
		minHeight: 720,
		title: "Codework",
		backgroundColor: "#171412",
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

	if (isDevelopment) {
		void window.loadURL(devServerUrl as string);
		window.webContents.openDevTools({ mode: "detach" });
		return;
	}

	void window.loadFile(rendererIndexPath);
}

void app.whenReady().then(() => {
	registerDesktopIpc();
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
