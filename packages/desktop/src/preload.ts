import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "@codeworksh/bridge";

const GET_APP_BRANDING_CHANNEL = "desktop:get-app-branding";
const GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL = "desktop:get-local-environment-bootstrap";
const GET_SERVER_EXPOSURE_STATE_CHANNEL = "desktop:get-server-exposure-state";
const SET_SERVER_EXPOSURE_MODE_CHANNEL = "desktop:set-server-exposure-mode";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const CONFIRM_CHANNEL = "desktop:confirm";
const SET_THEME_CHANNEL = "desktop:set-theme";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_SET_CHANNEL_CHANNEL = "desktop:update-set-channel";
const UPDATE_CHECK_CHANNEL = "desktop:update-check";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";

contextBridge.exposeInMainWorld("desktopBridge", {
	getAppBranding: () => {
		const result = ipcRenderer.sendSync(GET_APP_BRANDING_CHANNEL);
		if (typeof result !== "object" || result === null) {
			return null;
		}
		return result as ReturnType<DesktopBridge["getAppBranding"]>;
	},
	getLocalEnvironmentBootstrap: () => {
		const result = ipcRenderer.sendSync(GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL);
		if (typeof result !== "object" || result === null) {
			return null;
		}
		return result as ReturnType<DesktopBridge["getLocalEnvironmentBootstrap"]>;
	},
	getServerExposureState: () => ipcRenderer.invoke(GET_SERVER_EXPOSURE_STATE_CHANNEL),
	setServerExposureMode: (mode: Parameters<DesktopBridge["setServerExposureMode"]>[0]) =>
		ipcRenderer.invoke(SET_SERVER_EXPOSURE_MODE_CHANNEL, mode),
	openExternal: (url: string) => ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),
	confirm: (message: string) => ipcRenderer.invoke(CONFIRM_CHANNEL, message),
	setTheme: (theme: Parameters<DesktopBridge["setTheme"]>[0]) => ipcRenderer.invoke(SET_THEME_CHANNEL, theme),
	getUpdateState: () => ipcRenderer.invoke(UPDATE_GET_STATE_CHANNEL),
	setUpdateChannel: (channel: Parameters<DesktopBridge["setUpdateChannel"]>[0]) =>
		ipcRenderer.invoke(UPDATE_SET_CHANNEL_CHANNEL, channel),
	checkForUpdate: () => ipcRenderer.invoke(UPDATE_CHECK_CHANNEL),
	downloadUpdate: () => ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL),
	installUpdate: () => ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL),
	onUpdateState: (listener: Parameters<DesktopBridge["onUpdateState"]>[0]) => {
		const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
			if (typeof state !== "object" || state === null) return;
			listener(state as Parameters<typeof listener>[0]);
		};

		ipcRenderer.on(UPDATE_STATE_CHANNEL, wrappedListener);
		return () => {
			ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, wrappedListener);
		};
	},
} satisfies DesktopBridge);
