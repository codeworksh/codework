import type { DesktopRuntimeInfo, DesktopUpdateChannel, DesktopUpdateState } from "@codeworksh/bridge";

import { getCanRetryAfterDownloadFailure, nextStatusAfterDownloadFailure } from "../update/state.ts";

export function createInitialDesktopUpdateState(
	currentVersion: string,
	runtimeInfo: DesktopRuntimeInfo,
	channel: DesktopUpdateChannel,
): DesktopUpdateState {
	return {
		enabled: false,
		status: "disabled",
		channel,
		currentVersion,
		hostArch: runtimeInfo.hostArch,
		appArch: runtimeInfo.appArch,
		runningUnderArm64Translation: runtimeInfo.runningUnderArm64Translation,
		availableVersion: null,
		downloadedVersion: null,
		downloadPercent: null,
		checkedAt: null,
		message: null,
		errorContext: null,
		canRetry: false,
	};
}

export function reduceDesktopUpdateStateOnCheckStart(state: DesktopUpdateState, checkedAt: string): DesktopUpdateState {
	return {
		...state,
		status: "checking",
		checkedAt,
		message: null,
		downloadPercent: null,
		errorContext: null,
		canRetry: false,
	};
}

export function reduceDesktopUpdateStateOnCheckFailure(
	state: DesktopUpdateState,
	message: string,
	checkedAt: string,
): DesktopUpdateState {
	return {
		...state,
		status: "error",
		message,
		checkedAt,
		downloadPercent: null,
		errorContext: "check",
		canRetry: true,
	};
}

export function reduceDesktopUpdateStateOnDownloadFailure(
	state: DesktopUpdateState,
	message: string,
): DesktopUpdateState {
	return {
		...state,
		status: nextStatusAfterDownloadFailure(state),
		message,
		downloadPercent: null,
		errorContext: "download",
		canRetry: getCanRetryAfterDownloadFailure(state),
	};
}
