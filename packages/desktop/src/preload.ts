import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "@codeworksh/bridge";

const GET_APP_BRANDING_CHANNEL = "desktop:get-app-branding";

contextBridge.exposeInMainWorld("desktopBridge", {
	getAppBranding: () => {
		const result = ipcRenderer.sendSync(GET_APP_BRANDING_CHANNEL);
		if (typeof result !== "object" || result === null) {
			return null;
		}
		return result as ReturnType<DesktopBridge["getAppBranding"]>;
	},
});
