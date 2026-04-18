/// <reference types="vite/client" />

interface DesktopAppInfo {
	name: string;
	version: string;
	platform: NodeJS.Platform;
}

interface DesktopApi {
	getAppInfo(): Promise<DesktopAppInfo>;
}

declare global {
	interface Window {
		desktop?: DesktopApi;
	}
}

export {};
