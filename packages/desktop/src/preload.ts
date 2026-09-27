import { contextBridge, ipcRenderer } from "electron";
import type { ConnectResult, DesktopApi, LiveEvent, RepoState, SessionRow, Status } from "./bridge.ts";

const listen = <A>(channel: string, callback: (value: A) => void) => {
	const listener = (_event: Electron.IpcRendererEvent, value: A) => {
		callback(value);
	};
	ipcRenderer.on(channel, listener);
	return () => {
		ipcRenderer.off(channel, listener);
	};
};

const desktop: DesktopApi = {
	connect: (url) => ipcRenderer.invoke("desktop:connect", url) as Promise<ConnectResult>,
	disconnect: () => ipcRenderer.invoke("desktop:disconnect") as Promise<void>,
	repos: {
		list: () => ipcRenderer.invoke("desktop:repos.list") as Promise<RepoState>,
		open: () => ipcRenderer.invoke("desktop:repos.open") as Promise<RepoState | undefined>,
		select: (path) => ipcRenderer.invoke("desktop:repos.select", path) as Promise<RepoState>,
		remove: (path) => ipcRenderer.invoke("desktop:repos.remove", path) as Promise<RepoState>,
	},
	sessions: {
		list: () => ipcRenderer.invoke("desktop:sessions.list") as Promise<ReadonlyArray<SessionRow>>,
		create: (input) => ipcRenderer.invoke("desktop:sessions.create", input) as Promise<SessionRow>,
		prompt: (input) => ipcRenderer.invoke("desktop:sessions.prompt", input) as Promise<void>,
	},
	onStatus: (callback) => listen<Status>("desktop:status", callback),
	onEvent: (callback) => listen<LiveEvent>("desktop:event", callback),
};

contextBridge.exposeInMainWorld("desktop", desktop);
