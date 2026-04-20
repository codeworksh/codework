export type DesktopAppStageLabel = "Alpha" | "Dev" | "Nightly";

export interface DesktopAppBranding {
	baseName: string;
	stageLabel: DesktopAppStageLabel;
	displayName: string;
}

export type DesktopRuntimeArch = "arm64" | "x64" | "other";

export interface DesktopRuntimeInfo {
	hostArch: DesktopRuntimeArch;
	appArch: DesktopRuntimeArch;
	runningUnderArm64Translation: boolean;
}

export type DesktopUpdateChannel = "latest" | "nightly";


export interface DesktopBridge {
	getAppBranding: () => DesktopAppBranding | null;
}

export interface LocalApi {}