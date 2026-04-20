export type DesktopAppStageLabel = "Alpha" | "Dev" | "Nightly";

export interface DesktopAppBranding {
	baseName: string;
	stageLabel: DesktopAppStageLabel;
	displayName: string;
}

export type DesktopRuntimeArch = "arm64" | "x64" | "other";
export type DesktopUpdateStatus =
	| "disabled"
	| "idle"
	| "checking"
	| "up-to-date"
	| "available"
	| "downloading"
	| "downloaded"
	| "error";

export interface DesktopRuntimeInfo {
	hostArch: DesktopRuntimeArch;
	appArch: DesktopRuntimeArch;
	runningUnderArm64Translation: boolean;
}

export type DesktopUpdateChannel = "latest" | "nightly";

export interface DesktopUpdateState {
	enabled: boolean;
	status: DesktopUpdateStatus;
	channel: DesktopUpdateChannel;
	currentVersion: string;
	hostArch: DesktopRuntimeArch;
	appArch: DesktopRuntimeArch;
	runningUnderArm64Translation: boolean;
	availableVersion: string | null;
	downloadedVersion: string | null;
	downloadPercent: number | null;
	checkedAt: string | null;
	message: string | null;
	errorContext: "check" | "download" | "install" | null;
	canRetry: boolean;
}

export interface DesktopUpdateActionResult {
	accepted: boolean;
	completed: boolean;
	state: DesktopUpdateState;
}

export interface DesktopUpdateCheckResult {
	checked: boolean;
	state: DesktopUpdateState;
}

export interface DesktopBridge {
	getAppBranding: () => DesktopAppBranding | null;
	getUpdateState: () => Promise<DesktopUpdateState>;
	setUpdateChannel: (channel: DesktopUpdateChannel) => Promise<DesktopUpdateState>;
	checkForUpdate: () => Promise<DesktopUpdateCheckResult>;
	downloadUpdate: () => Promise<DesktopUpdateActionResult>;
	installUpdate: () => Promise<DesktopUpdateActionResult>;
	onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
}

export interface LocalApi {}
