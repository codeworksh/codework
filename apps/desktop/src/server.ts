import { app, ipcMain } from "electron";
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { SERVER_CHANNEL } from "./ipc.ts";
import { channel } from "./manifest.ts";

// The server bundle: in the app's Resources when packaged, else beside this app in the workspace.
const ENTRY = app.isPackaged
	? path.join(process.resourcesPath, "server", "index.mjs")
	: path.resolve(app.getAppPath(), "../server/dist/index.mjs");

// How long the server gets to stop by itself on quit before it is killed.
const STOP_GRACE_MS = 5000;

/** Where the renderer reaches the app server, and the token its door takes. */
export interface Endpoint {
	readonly url: string;
	readonly token: string;
}

/** Starts the app server and resolves with its RPC endpoint once it listens. */
export function startServer(): Promise<Endpoint> {
	// Electron's own binary in Node mode: no system Node needed, and the child
	// does not become a second GUI app instance.
	const child = spawn(process.execPath, [ENTRY], {
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
			// The app server keeps app.db in the CodeWork home under desktop/<channel>; from the repo, `local`.
			CODEWORK_CHANNEL: channel(),
		},
		stdio: ["ignore", "pipe", "inherit"],
	});

	// Quitting waits for the server to stop, asked with SIGTERM and killed if it outlasts the grace, so
	// the app never leaves it running.
	let stopping = false;
	const running = () => child.exitCode === null && child.signalCode === null;
	app.on("before-quit", (event) => {
		if (!running()) return;
		event.preventDefault();
		if (stopping) return;
		stopping = true;
		const force = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
		child.once("exit", () => {
			clearTimeout(force);
			app.quit();
		});
		child.kill("SIGTERM");
	});

	return new Promise((resolve, reject) => {
		let ready = false;
		child.once("exit", (code, signal) => {
			if (stopping) return;
			if (!ready) return reject(new Error(`server exited before ready (code ${code}, signal ${signal})`));
			// No restart yet: the app is unusable without its server, so it ends
			// with it and the dev runner (or the user) starts it again.
			console.error(`server exited (code ${code}, signal ${signal})`);
			app.quit();
		});

		createInterface({ input: child.stdout }).on("line", (line) => {
			// The ready line carries the token, so it is the one line never echoed.
			if (!ready && line.startsWith('{"type":"ready"')) {
				ready = true;
				const { port, token } = JSON.parse(line) as { port: number; token: string };
				const endpoint: Endpoint = { url: `ws://127.0.0.1:${port}/rpc`, token };
				ipcMain.on(SERVER_CHANNEL, (event) => {
					event.returnValue = endpoint;
				});
				resolve(endpoint);
				return;
			}
			console.log(`[server] ${line}`);
		});
	});
}
