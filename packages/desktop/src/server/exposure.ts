import type { NetworkInterfaceInfo } from "node:os";
import type { DesktopServerExposureMode } from "@codeworksh/bridge";

const DESKTOP_LOOPBACK_HOST = "127.0.0.1";
const DESKTOP_LAN_BIND_HOST = "0.0.0.0";

export interface DesktopServerExposure {
	mode: DesktopServerExposureMode;
	bindHost: string;
	localHttpUrl: string;
	localWsUrl: string;
	endpointUrl: string | null;
	advertisedHost: string | null;
}

function normalizeOptionalHost(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized && normalized.length > 0 ? normalized : undefined;
}

function isUsableLanIpv4Address(address: string): boolean {
	return !address.startsWith("127.") && !address.startsWith("169.254.");
}

export function resolveLanAdvertisedHost(
	networkInterfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
	explicitHost: string | undefined,
): string | null {
	const normalizedExplicitHost = normalizeOptionalHost(explicitHost);
	if (normalizedExplicitHost) {
		return normalizedExplicitHost;
	}

	for (const interfaceAddresses of Object.values(networkInterfaces)) {
		if (!interfaceAddresses) continue;

		for (const address of interfaceAddresses) {
			if (address.internal) continue;
			if (address.family !== "IPv4") continue;
			if (!isUsableLanIpv4Address(address.address)) continue;
			return address.address;
		}
	}

	return null;
}

export function resolveDesktopServerExposure(input: {
	mode: DesktopServerExposureMode;
	port: number;
	networkInterfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
	advertisedHostOverride?: string;
}): DesktopServerExposure {
	const localHttpUrl = `http://${DESKTOP_LOOPBACK_HOST}:${input.port}`;
	const localWsUrl = `ws://${DESKTOP_LOOPBACK_HOST}:${input.port}`;

	if (input.mode === "local-only") {
		return {
			mode: input.mode,
			bindHost: DESKTOP_LOOPBACK_HOST,
			localHttpUrl,
			localWsUrl,
			endpointUrl: null,
			advertisedHost: null,
		};
	}

	const advertisedHost = resolveLanAdvertisedHost(
		input.networkInterfaces,
		input.advertisedHostOverride,
	);

	return {
		mode: input.mode,
		bindHost: DESKTOP_LAN_BIND_HOST,
		localHttpUrl,
		localWsUrl,
		endpointUrl: advertisedHost ? `http://${advertisedHost}:${input.port}` : null,
		advertisedHost,
	};
}
