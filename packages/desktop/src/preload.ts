import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("desktop", {
	version: "0.0.0",
});
