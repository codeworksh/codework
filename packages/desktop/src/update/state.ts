import type { DesktopUpdateState } from "@codeworksh/bridge";

export function getAutoUpdateDisabledReason(args: {
	readonly isDevelopment: boolean;
	readonly isPackaged: boolean;
	readonly hasUpdateFeedConfig: boolean;
}): string | null {
	if (!args.hasUpdateFeedConfig) {
		return "Automatic updates are not available because no update feed is configured.";
	}
	if (args.isDevelopment || !args.isPackaged) {
		return "Automatic updates are only available in packaged production builds.";
	}
	return null;
}

export function nextStatusAfterDownloadFailure(currentState: DesktopUpdateState): DesktopUpdateState["status"] {
	return currentState.availableVersion ? "available" : "error";
}

export function getCanRetryAfterDownloadFailure(currentState: DesktopUpdateState): boolean {
	return currentState.availableVersion !== null;
}
