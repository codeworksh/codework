declare global {
	interface Window {
		desktopBridge?: {
			platform: string;
			/** The app server's RPC WebSocket URL. */
			server: string;
		};
	}
}

/**
 * True when running inside the Electron preload bridge, false in a regular
 * browser. The preload sets window.desktopBridge via contextBridge before any
 * web-app code executes, so this is reliable at module load time.
 */
export const isElectron = typeof window !== "undefined" && window.desktopBridge !== undefined;
