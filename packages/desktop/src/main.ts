import { app, BrowserWindow, ipcMain, nativeTheme, shell } from "electron";
import { join } from "node:path";
import type {
	DesktopAppBranding,
	DesktopServerExposureState,
	DesktopTheme,
	DesktopUpdateActionResult,
	DesktopUpdateChannel,
	DesktopUpdateCheckResult,
	DesktopUpdateState,
} from "@codeworksh/bridge";
import { configureDesktopAppIdentity } from "./app/identity.ts";
import { resolveDesktopAppBranding } from "./branding.ts";
import { showDesktopConfirmDialog } from "./dialog/confirm.ts";
import { resolveDesktopRuntimeInfo } from "./arch.ts";
import { resolveDesktopLocalEnvironmentBootstrap } from "./environment/bootstrap.ts";
import { syncShellEnvironment } from "./shell/environment.ts";
import {
	readDesktopSettings,
	setDesktopServerExposurePreference,
	setDesktopUpdateChannelPreference,
	writeDesktopSettings,
} from "./settings/desktop.ts";
import {
	createInitialDesktopUpdateState,
	reduceDesktopUpdateStateOnCheckFailure,
	reduceDesktopUpdateStateOnCheckStart,
	reduceDesktopUpdateStateOnDownloadFailure,
} from "./app/machine.ts";
import { resolveDefaultDesktopUpdateChannel } from "./app/channel.ts";
import { getAutoUpdateDisabledReason } from "./app/state.ts";

syncShellEnvironment();

const GET_APP_BRANDING_CHANNEL = "desktop:get-app-branding";
const GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL = "desktop:get-local-environment-bootstrap";
const GET_SERVER_EXPOSURE_STATE_CHANNEL = "desktop:get-server-exposure-state";
const SET_SERVER_EXPOSURE_MODE_CHANNEL = "desktop:set-server-exposure-mode";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const CONFIRM_CHANNEL = "desktop:confirm";
const SET_THEME_CHANNEL = "desktop:set-theme";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_SET_CHANNEL_CHANNEL = "desktop:update-set-channel";
const UPDATE_CHECK_CHANNEL = "desktop:update-check";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";

const devServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
const isDevelopment = Boolean(devServerUrl);
const rendererIndexPath = join(__dirname, "..", "renderer", "index.html");
const desktopSettingsPath = join(app.getPath("userData"), "desktop-settings.json");

const desktopAppBranding: DesktopAppBranding = resolveDesktopAppBranding({
	isDevelopment,
	appVersion: app.getVersion(),
});
const APP_DISPLAY_NAME = desktopAppBranding.displayName;

const desktopRuntimeInfo = resolveDesktopRuntimeInfo({
	platform: process.platform,
	processArch: process.arch,
	runningUnderArm64Translation: app.runningUnderARM64Translation,
});
const updateFeedConfigured = false;
let desktopSettings = readDesktopSettings(desktopSettingsPath, app.getVersion());
let updateState = createBaseUpdateState(desktopSettings.updateChannel);

function getSafeTheme(rawTheme: unknown): DesktopTheme | null {
	if (rawTheme === "light" || rawTheme === "dark" || rawTheme === "system") {
		return rawTheme;
	}

	return null;
}

function getDesktopServerExposureState(): DesktopServerExposureState {
	const bootstrap = resolveDesktopLocalEnvironmentBootstrap({
		serverExposureMode: desktopSettings.serverExposureMode,
	});

	return {
		mode: bootstrap.serverExposureMode,
		endpointUrl: bootstrap.endpointUrl,
		advertisedHost: bootstrap.advertisedHost,
	};
}

function registerIpcHandlers(): void {
	ipcMain.removeAllListeners(GET_APP_BRANDING_CHANNEL);

	ipcMain.on(GET_APP_BRANDING_CHANNEL, (event) => {
		event.returnValue = desktopAppBranding;
	});

	ipcMain.removeAllListeners(GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL);
	ipcMain.on(GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL, (event) => {
		event.returnValue = resolveDesktopLocalEnvironmentBootstrap({
			serverExposureMode: desktopSettings.serverExposureMode,
		});
	});

	ipcMain.removeHandler(GET_SERVER_EXPOSURE_STATE_CHANNEL);
	ipcMain.handle(GET_SERVER_EXPOSURE_STATE_CHANNEL, async () => getDesktopServerExposureState());

	ipcMain.removeHandler(SET_SERVER_EXPOSURE_MODE_CHANNEL);
	ipcMain.handle(SET_SERVER_EXPOSURE_MODE_CHANNEL, async (_event, rawMode: unknown) => {
		if (rawMode !== "local-only" && rawMode !== "network-accessible") {
			throw new Error("Invalid desktop server exposure mode input.");
		}

		desktopSettings = setDesktopServerExposurePreference(desktopSettings, rawMode);
		writeDesktopSettings(desktopSettingsPath, desktopSettings);
		return getDesktopServerExposureState();
	});

	ipcMain.removeHandler(OPEN_EXTERNAL_CHANNEL);
	ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (_event, rawUrl: unknown) => {
		const safeUrl = getSafeExternalUrl(rawUrl);
		if (!safeUrl) {
			return false;
		}

		await shell.openExternal(safeUrl);
		return true;
	});

	ipcMain.removeHandler(CONFIRM_CHANNEL);
	ipcMain.handle(CONFIRM_CHANNEL, async (event, rawMessage: unknown) => {
		if (typeof rawMessage !== "string") {
			return false;
		}

		return await showDesktopConfirmDialog(rawMessage, BrowserWindow.fromWebContents(event.sender));
	});

	ipcMain.removeHandler(SET_THEME_CHANNEL);
	ipcMain.handle(SET_THEME_CHANNEL, async (_event, rawTheme: unknown) => {
		const theme = getSafeTheme(rawTheme);
		if (!theme) {
			throw new Error("Invalid desktop theme input.");
		}

		nativeTheme.themeSource = theme;
		syncAllWindowAppearance();
		return nativeTheme.themeSource as DesktopTheme;
	});

	ipcMain.removeHandler(UPDATE_GET_STATE_CHANNEL);
	ipcMain.handle(UPDATE_GET_STATE_CHANNEL, async () => updateState);

	ipcMain.removeHandler(UPDATE_SET_CHANNEL_CHANNEL);
	ipcMain.handle(UPDATE_SET_CHANNEL_CHANNEL, async (_event, rawChannel: unknown) => {
		if (rawChannel !== "latest" && rawChannel !== "nightly") {
			throw new Error("Invalid desktop update channel input.");
		}

		desktopSettings = setDesktopUpdateChannelPreference(desktopSettings, rawChannel);
		writeDesktopSettings(desktopSettingsPath, desktopSettings);
		updateState = createBaseUpdateState(desktopSettings.updateChannel);
		emitUpdateState();
		return updateState;
	});

	ipcMain.removeHandler(UPDATE_CHECK_CHANNEL);
	ipcMain.handle(UPDATE_CHECK_CHANNEL, async () => {
		const checkedAt = new Date().toISOString();
		updateState = reduceDesktopUpdateStateOnCheckStart(updateState, checkedAt);
		emitUpdateState();

		const disabledReason = getAutoUpdateDisabledReason({
			isDevelopment,
			isPackaged: app.isPackaged,
			hasUpdateFeedConfig: updateFeedConfigured,
		});

		updateState = disabledReason
			? {
					...createBaseUpdateState(updateState.channel),
					checkedAt,
					message: disabledReason,
				}
			: reduceDesktopUpdateStateOnCheckFailure(
					updateState,
					"Update checks are not implemented for this desktop build yet.",
					checkedAt,
				);
		emitUpdateState();

		return {
			checked: false,
			state: updateState,
		} satisfies DesktopUpdateCheckResult;
	});

	ipcMain.removeHandler(UPDATE_DOWNLOAD_CHANNEL);
	ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, async () => {
		updateState = reduceDesktopUpdateStateOnDownloadFailure(
			updateState,
			"No downloaded update is available for this desktop build yet.",
		);
		emitUpdateState();

		return {
			accepted: false,
			completed: false,
			state: updateState,
		} satisfies DesktopUpdateActionResult;
	});

	ipcMain.removeHandler(UPDATE_INSTALL_CHANNEL);
	ipcMain.handle(UPDATE_INSTALL_CHANNEL, async () => {
		updateState = {
			...updateState,
			message: "There is no downloaded update to install yet.",
			errorContext: "install",
			canRetry: false,
		};
		emitUpdateState();

		return {
			accepted: false,
			completed: false,
			state: updateState,
		} satisfies DesktopUpdateActionResult;
	});
}

function createBaseUpdateState(channel: DesktopUpdateChannel): DesktopUpdateState {
	const disabledReason = getAutoUpdateDisabledReason({
		isDevelopment,
		isPackaged: app.isPackaged,
		hasUpdateFeedConfig: updateFeedConfigured,
	});
	const resolvedChannel =
		desktopSettings.updateChannelConfiguredByUser === true
			? desktopSettings.updateChannel
			: resolveDefaultDesktopUpdateChannel(app.getVersion());
	const baseState = createInitialDesktopUpdateState(
		app.getVersion(),
		desktopRuntimeInfo,
		channel === resolvedChannel ? channel : resolvedChannel,
	);

	if (disabledReason) {
		return {
			...baseState,
			message: disabledReason,
		};
	}

	return {
		...baseState,
		enabled: true,
		status: "idle",
	};
}

function emitUpdateState(): void {
	for (const window of BrowserWindow.getAllWindows()) {
		window.webContents.send(UPDATE_STATE_CHANNEL, updateState);
	}
}

function getSafeExternalUrl(rawUrl: unknown): string | null {
	if (typeof rawUrl !== "string" || rawUrl.length === 0) {
		return null;
	}

	try {
		const parsedUrl = new URL(rawUrl);
		if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
			return null;
		}
		return parsedUrl.toString();
	} catch {
		return null;
	}
}

function getInitialWindowBackgroundColor(): string {
	return nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff";
}

function syncWindowAppearance(window: BrowserWindow): void {
	if (window.isDestroyed()) {
		return;
	}

	window.setBackgroundColor(getInitialWindowBackgroundColor());
}

function syncAllWindowAppearance(): void {
	for (const window of BrowserWindow.getAllWindows()) {
		syncWindowAppearance(window);
	}
}

nativeTheme.on("updated", syncAllWindowAppearance);

function createWindow(): BrowserWindow {
	const window = new BrowserWindow({
		width: 1100,
		height: 780,
		minWidth: 840,
		minHeight: 620,
		show: false,
		autoHideMenuBar: true,
		backgroundColor: getInitialWindowBackgroundColor(),
		title: APP_DISPLAY_NAME,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			preload: join(__dirname, "preload.cjs"),
		},
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		const externalUrl = getSafeExternalUrl(url);
		if (externalUrl) {
			void shell.openExternal(externalUrl);
		}
		return { action: "deny" };
	});

	window.on("page-title-updated", (event) => {
		event.preventDefault();
		window.setTitle(APP_DISPLAY_NAME);
	});

	window.once("ready-to-show", () => {
		window.show();
	});

	window.webContents.on("did-finish-load", () => {
		window.setTitle(APP_DISPLAY_NAME);
		emitUpdateState();
	});

	if (isDevelopment) {
		void window.loadURL(devServerUrl as string);
		window.webContents.openDevTools({ mode: "detach" });
		return window;
	}

	void window.loadFile(rendererIndexPath);
	return window;
}

void app.whenReady().then(() => {
	configureDesktopAppIdentity({
		isDevelopment,
		branding: desktopAppBranding,
	});
	registerIpcHandlers();
	createWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
});

void app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});
