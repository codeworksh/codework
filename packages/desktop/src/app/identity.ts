import { app } from "electron";
import type { DesktopAppBranding } from "@codeworksh/bridge";

function resolveDesktopAppUserModelId(isDevelopment: boolean): string {
	return isDevelopment ? "com.codeworksh.codework.dev" : "com.codeworksh.codework";
}

export function configureDesktopAppIdentity(input: { isDevelopment: boolean; branding: DesktopAppBranding }): void {
	app.setName(input.branding.displayName);
	app.setAboutPanelOptions({
		applicationName: input.branding.displayName,
		applicationVersion: app.getVersion(),
	});

	if (process.platform === "win32") {
		app.setAppUserModelId(resolveDesktopAppUserModelId(input.isDevelopment));
	}
}
