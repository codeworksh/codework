declare global {
	interface Window {
		desktopBridge?: {
			platform: string;
			/** The app server's RPC WebSocket URL. */
			server: string;
			/** The user's home directory. */
			home: string;
			/** Opens the native folder dialog at `from`; the chosen folder, or null when cancelled. */
			pickFolder: (from: string) => Promise<string | null>;
		};
	}
}

/**
 * True when running inside the Electron preload bridge, false in a regular
 * browser. The preload sets window.desktopBridge via contextBridge before any
 * web-app code executes, so this is reliable at module load time.
 */
export const isElectron = typeof window !== "undefined" && window.desktopBridge !== undefined;
