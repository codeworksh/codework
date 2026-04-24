import { access } from "node:fs/promises";
import { join } from "node:path";
import { createConnection } from "node:net";

const pollIntervalMs = 100;
const timeoutMs = 30_000;

async function fileExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function tcpPortIsReady({ host, port, connectTimeoutMs = 500 }) {
	return new Promise((resolve) => {
		const socket = createConnection({ host, port });
		let settled = false;

		const finish = (ready) => {
			if (settled) {
				return;
			}

			settled = true;
			socket.removeAllListeners();
			socket.destroy();
			resolve(ready);
		};

		socket.once("connect", () => finish(true));
		socket.once("timeout", () => finish(false));
		socket.once("error", () => finish(false));
		socket.setTimeout(connectTimeoutMs);
	});
}

export async function waitForResources({ baseDir, files, tcpHost, tcpPort }) {
	const startTime = Date.now();

	while (Date.now() - startTime < timeoutMs) {
		const checks = await Promise.all(files.map((file) => fileExists(join(baseDir, file))));
		const tcpReady =
			typeof tcpPort === "number" && tcpPort > 0
				? await tcpPortIsReady({ host: tcpHost ?? "127.0.0.1", port: tcpPort })
				: true;

		if (checks.every(Boolean) && tcpReady) {
			return;
		}

		await new Promise((resolve) => {
			setTimeout(resolve, pollIntervalMs);
		});
	}

	const pendingResources = [...files];
	if (typeof tcpPort === "number" && tcpPort > 0) {
		pendingResources.push(`tcp:${tcpHost ?? "127.0.0.1"}:${tcpPort}`);
	}

	throw new Error(`Timed out waiting for resources: ${pendingResources.join(", ")}`);
}
