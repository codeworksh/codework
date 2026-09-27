import { app, BrowserWindow, ipcMain } from "electron";
import { Effect, Exit, Result, Scope } from "effect";
import { join } from "node:path";
import { DefaultUrl, type ConnectResult, type LiveEvent, type Status } from "./bridge.ts";
import { Repos } from "./repos.ts";
import { connect, type Handle } from "./rpc.ts";

const serveHint = (url: string) => `Nothing listening at ${url}. Start the server with: codework serve`;

let scope: Scope.Closeable | undefined;
let handle: Handle | undefined;
let attaching: Promise<unknown> = Promise.resolve();

const broadcast = (channel: string, payload: Status | LiveEvent) => {
	for (const window of BrowserWindow.getAllWindows()) {
		window.webContents.send(channel, payload);
	}
};

const publish = (event: LiveEvent) => {
	broadcast("desktop:event", event);
};

const close = async () => {
	const current = scope;
	scope = undefined;
	handle = undefined;
	if (current !== undefined) await Effect.runPromise(Scope.close(current, Exit.void));
};

const disconnect = () => {
	const run = attaching.then(close, close);
	attaching = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
};

const attach = (url: string): Promise<ConnectResult> => {
	const run = attaching.then(async () => {
		await close();
		const next = await Effect.runPromise(Scope.make());
		const opened = await Effect.runPromise(connect(url, publish).pipe(Scope.provide(next), Effect.result));
		if (Result.isFailure(opened)) {
			await Effect.runPromise(Scope.close(next, Exit.void));
			const status = { connected: false, url, error: serveHint(url) } as const;
			broadcast("desktop:status", status);
			return { ok: false, error: status.error } as const;
		}
		scope = next;
		handle = opened.success;
		const status = { connected: true, url: opened.success.url } as const;
		broadcast("desktop:status", status);
		return { ok: true, url: opened.success.url } as const;
	});
	attaching = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
};

const requireHandle = () => {
	if (handle === undefined) throw new Error("Not connected. Start the server with: codework serve");
	return handle;
};

const createWindow = () => {
	const window = new BrowserWindow({
		width: 1100,
		height: 760,
		title: "CodeWork",
		backgroundColor: "#111113",
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.mjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	});

	window.webContents.on("preload-error", (_event, path, error) => {
		throw new Error(`Preload failed (${path}): ${error.message}`);
	});

	const renderer = process.env["ELECTRON_RENDERER_URL"];
	if (renderer !== undefined) {
		void window.loadURL(renderer);
	} else {
		void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
	}
};

ipcMain.handle("desktop:connect", (_event, url?: string) => attach(url ?? DefaultUrl));
ipcMain.handle("desktop:disconnect", () => disconnect());
ipcMain.handle("desktop:repos.list", () => Repos.list());
ipcMain.handle("desktop:repos.open", (event) => Repos.open(BrowserWindow.fromWebContents(event.sender) ?? undefined));
ipcMain.handle("desktop:repos.select", (_event, path: string) => Repos.select(path));
ipcMain.handle("desktop:repos.remove", (_event, path: string) => Repos.remove(path));
ipcMain.handle("desktop:sessions.list", () => Effect.runPromise(requireHandle().list));
ipcMain.handle("desktop:sessions.create", (_event, input?: { readonly title?: string; readonly hostDir?: string }) =>
	Effect.runPromise(requireHandle().create(input)),
);
ipcMain.handle("desktop:sessions.prompt", (_event, input: { readonly sessionId: string; readonly text: string }) =>
	Effect.runPromise(requireHandle().prompt(input)),
);

void app.whenReady().then(() => {
	createWindow();
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
	void disconnect();
});
