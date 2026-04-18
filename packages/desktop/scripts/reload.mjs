import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { join } from "node:path";

import { desktopDir, resolveElectronPath } from "./launch.mjs";
import { waitForResources } from "./wait.mjs";

const devServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
if (!devServerUrl) {
	throw new Error("VITE_DEV_SERVER_URL is required for desktop development.");
}

const devServer = new URL(devServerUrl);
const devServerPort = Number.parseInt(devServer.port, 10);
if (!Number.isInteger(devServerPort) || devServerPort <= 0) {
	throw new Error(`VITE_DEV_SERVER_URL must include an explicit port: ${devServerUrl}`);
}

const requiredFiles = ["dist/electron/main.cjs", "dist/electron/preload.cjs"];
const watchedDirectory = { directory: "dist/electron", files: new Set(["main.cjs", "preload.cjs"]) };
const forcedShutdownTimeoutMs = 1_500;
const restartDebounceMs = 120;

await waitForResources({
	baseDir: desktopDir,
	files: requiredFiles,
	tcpHost: devServer.hostname,
	tcpPort: devServerPort,
});

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

let shuttingDown = false;
let restartTimer = null;
let currentApp = null;
let restartQueue = Promise.resolve();
const expectedExits = new WeakSet();

function startApp() {
	if (shuttingDown || currentApp !== null) {
		return;
	}

	const app = spawn(resolveElectronPath(), ["dist/electron/main.cjs"], {
		cwd: desktopDir,
		env: childEnv,
		stdio: "inherit",
	});

	currentApp = app;

	app.once("error", () => {
		if (currentApp === app) {
			currentApp = null;
		}

		if (!shuttingDown) {
			scheduleRestart();
		}
	});

	app.once("exit", (code, signal) => {
		if (currentApp === app) {
			currentApp = null;
		}

		const exitedAbnormally = signal !== null || code !== 0;
		if (!shuttingDown && !expectedExits.has(app) && exitedAbnormally) {
			scheduleRestart();
		}
	});
}

async function stopApp() {
	const app = currentApp;
	if (!app) {
		return;
	}

	currentApp = null;
	expectedExits.add(app);

	await new Promise((resolve) => {
		let settled = false;

		const finish = () => {
			if (settled) {
				return;
			}

			settled = true;
			resolve();
		};

		app.once("exit", finish);
		app.kill("SIGTERM");

		setTimeout(() => {
			if (settled) {
				return;
			}

			app.kill("SIGKILL");
			finish();
		}, forcedShutdownTimeoutMs).unref();
	});
}

function scheduleRestart() {
	if (shuttingDown) {
		return;
	}

	if (restartTimer) {
		clearTimeout(restartTimer);
	}

	restartTimer = setTimeout(() => {
		restartTimer = null;
		restartQueue = restartQueue
			.catch(() => undefined)
			.then(async () => {
				await stopApp();
				if (!shuttingDown) {
					startApp();
				}
			});
	}, restartDebounceMs);
}

const watcher = watch(join(desktopDir, watchedDirectory.directory), { persistent: true }, (_eventType, filename) => {
	if (typeof filename !== "string" || !watchedDirectory.files.has(filename)) {
		return;
	}

	scheduleRestart();
});

async function shutdown(exitCode) {
	if (shuttingDown) {
		return;
	}

	shuttingDown = true;
	if (restartTimer) {
		clearTimeout(restartTimer);
		restartTimer = null;
	}

	watcher.close();
	await stopApp();
	process.exit(exitCode);
}

startApp();

process.once("SIGINT", () => {
	void shutdown(130);
});

process.once("SIGTERM", () => {
	void shutdown(143);
});
