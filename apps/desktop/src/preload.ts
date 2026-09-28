import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("desktopBridge", {
	platform: process.platform,
});
