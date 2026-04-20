export type DesktopAppStageLabel = "Alpha" | "Dev" | "Nightly";

export interface DesktopAppBranding {
	baseName: string;
	stageLabel: DesktopAppStageLabel;
	displayName: string;
}


export interface DesktopBridge {
	getAppBranding: () => DesktopAppBranding | null;
}

export interface LocalApi {}