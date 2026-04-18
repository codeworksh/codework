import { app, BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function createWindow(): void {
	const window = new BrowserWindow({
		width: 960,
		height: 640,
		title: "Codework Desktop",
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: join(__dirname, "preload.cjs"),
		},
	});

	void window.loadFile(join(__dirname, "../../index.html"));
}

void app.whenReady().then(() => {
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
