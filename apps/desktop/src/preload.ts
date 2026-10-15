import { contextBridge, ipcRenderer } from "electron";
import { ROOT_CHANNEL, SERVER_CHANNEL } from "./ipc.ts";

contextBridge.exposeInMainWorld("desktopBridge", {
	platform: process.platform,
	// Main creates the window only after the server is ready, so this is set.
	server: ipcRenderer.sendSync(SERVER_CHANNEL) as string,
	root: ipcRenderer.sendSync(ROOT_CHANNEL) as string,
});
