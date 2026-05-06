import * as OS from "node:os";
import type { DesktopLocalEnvironmentBootstrap, DesktopServerExposureMode } from "@codeworksh/bridge";
import { resolveDesktopServerExposure } from "../server/exposure";

export const DEFAULT_DESKTOP_BACKEND_PORT = 3773;

export function resolveDesktopLocalEnvironmentBootstrap(input: {
	serverExposureMode: DesktopServerExposureMode;
	port?: number;
	advertisedHostOverride?: string;
}): DesktopLocalEnvironmentBootstrap {
	const port = input.port ?? DEFAULT_DESKTOP_BACKEND_PORT;
	const exposure = resolveDesktopServerExposure({
		mode: input.serverExposureMode,
		port,
		networkInterfaces: OS.networkInterfaces(),
		advertisedHostOverride: input.advertisedHostOverride,
	});

	return {
		serverExposureMode: exposure.mode,
		backendPort: port,
		localHttpUrl: exposure.localHttpUrl,
		localWsUrl: exposure.localWsUrl,
		endpointUrl: exposure.endpointUrl,
		advertisedHost: exposure.advertisedHost,
	};
}
