import type { DesktopAppBranding, DesktopAppStageLabel } from "@codeworksh/bridge";

import { isNightlyDesktopVersion } from "./update/channel.ts";

const APP_BASE_NAME = "CodeWork";

export function resolveDesktopAppStageLabel(input: {
    readonly isDevelopment: boolean;
    readonly appVersion: string;
}): DesktopAppStageLabel {
    if (input.isDevelopment) {
        return "Dev";
    }

    return isNightlyDesktopVersion(input.appVersion) ? "Nightly" : "Alpha";
}

export function resolveDesktopAppBranding(input: {
    readonly isDevelopment: boolean;
    readonly appVersion: string;
}): DesktopAppBranding {
    const stageLabel = resolveDesktopAppStageLabel(input);
    return {
        baseName: APP_BASE_NAME,
        stageLabel,
        displayName: `${APP_BASE_NAME} (${stageLabel})`,
    };
}
