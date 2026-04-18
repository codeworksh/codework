import { contextBridge, ipcRenderer } from "electron";

const getAppInfoChannel = "desktop:get-app-info";

contextBridge.exposeInMainWorld("desktop", {
	getAppInfo: () => ipcRenderer.invoke(getAppInfoChannel) as Promise<{
		name: string;
		version: string;
		platform: NodeJS.Platform;
	}>,
});
