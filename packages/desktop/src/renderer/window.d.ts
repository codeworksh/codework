import type { DesktopApi } from "../bridge.ts";

declare global {
	interface Window {
		readonly desktop?: DesktopApi;
	}
}

export {};
