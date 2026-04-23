import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const cwd = process.cwd();
const entry = path.join(cwd, "packages/agent/src/index.ts");
const watchRoot = path.join(cwd, "packages/agent/src");
const childArgs = ["--experimental-transform-types", entry, "serve", ...process.argv.slice(2)];
const pollIntervalMs = 250;
const restartDebounceMs = 120;

let child = null;
let restartTimer = null;
let pollTimer = null;
let shuttingDown = false;
let lastSnapshot = "";

async function collectFiles(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) return collectFiles(fullPath);
			if (!entry.isFile() || !fullPath.endsWith(".ts")) return [];
			return [fullPath];
		}),
	);
	return files.flat();
}

async function snapshotTree() {
	const files = await collectFiles(watchRoot);
	const stats = await Promise.all(
		files.sort().map(async (file) => {
			const info = await stat(file);
			return `${file}:${info.mtimeMs}:${info.size}`;
		}),
	);
	return stats.join("|");
}

function startChild() {
	child = spawn(process.execPath, childArgs, {
		cwd,
		stdio: "inherit",
	});

	child.on("exit", (code, signal) => {
		if (!shuttingDown && signal !== "SIGTERM" && code && code !== 0) {
			process.exitCode = code;
		}
		if (!shuttingDown && !restartTimer && signal === null && code === 0) {
			void shutdown();
		}
		child = null;
	});
}

function stopChild(signal = "SIGTERM") {
	if (!child || child.killed) return;
	child.kill(signal);
}

function scheduleRestart() {
	if (shuttingDown) return;
	if (restartTimer) clearTimeout(restartTimer);
	restartTimer = setTimeout(() => {
		restartTimer = null;
		stopChild();
		setTimeout(() => {
			if (!shuttingDown) startChild();
		}, 50);
	}, restartDebounceMs);
}

async function pollTree() {
	try {
		const nextSnapshot = await snapshotTree();
		if (!lastSnapshot) {
			lastSnapshot = nextSnapshot;
			return;
		}
		if (nextSnapshot !== lastSnapshot) {
			lastSnapshot = nextSnapshot;
			scheduleRestart();
		}
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
		void shutdown();
	}
}

async function shutdown(signal = "SIGTERM") {
	if (shuttingDown) return;
	shuttingDown = true;
	if (restartTimer) {
		clearTimeout(restartTimer);
		restartTimer = null;
	}
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
	stopChild(signal);
}

process.on("SIGINT", () => {
	void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
	void shutdown("SIGTERM");
});

lastSnapshot = await snapshotTree();
startChild();
pollTimer = setInterval(() => {
	void pollTree();
}, pollIntervalMs);
