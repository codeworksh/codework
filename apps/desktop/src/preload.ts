import { contextBridge, ipcRenderer } from "electron";
import { HOME_CHANNEL, PICK_FOLDER_CHANNEL, REVEAL_CHANNEL, SERVER_CHANNEL } from "./ipc.ts";

contextBridge.exposeInMainWorld("desktopBridge", {
	platform: process.platform,
	// Main creates the window only after the server is ready, so this is set.
	server: ipcRenderer.sendSync(SERVER_CHANNEL) as string,
	home: ipcRenderer.sendSync(HOME_CHANNEL) as string,
	// On Windows the CodeWork server runs in WSL, which has no use for the Windows paths these deal in.
	...(process.platform !== "win32" && {
		pickFolder: (from: string) => ipcRenderer.invoke(PICK_FOLDER_CHANNEL, from) as Promise<string | null>,
		reveal: (path: string) => ipcRenderer.invoke(REVEAL_CHANNEL, path) as Promise<void>,
	}),
});
