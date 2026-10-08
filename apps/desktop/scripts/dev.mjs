import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDir = path.resolve(desktopDir, "../web");
const outDir = path.join(desktopDir, "out");
const WEB_URL = "http://127.0.0.1:5173";
const startedAt = Date.now();

const children = new Set();

// Each child leads its own process group so shutdown also reaches the
// grandchildren (pnpm -> vp, start-electron -> Electron).
function run(command, args, options) {
	const child = spawn(command, args, { stdio: "inherit", detached: true, ...options });
	children.add(child);
	child.on("exit", () => children.delete(child));
	return child;
}

function stop(child) {
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {}
}

function shutdown() {
	for (const child of children) stop(child);
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Electron is useless without either, so losing one ends the session (this also
// catches Vite refusing an occupied port).
for (const [args, cwd] of [
	[["run", "dev"], webDir],
	[["exec", "vp", "pack", "--watch"], desktopDir],
]) {
	run("pnpm", args, { cwd }).on("exit", shutdown);
}

// Wait for fresh bundles and a reachable web server, so Electron
// does not boot on a stale bundle and immediately restart.
async function ready() {
	for (const file of ["main.cjs", "preload.cjs"]) {
		const built = await stat(path.join(outDir, file)).catch(() => null);
		if (built === null || built.mtimeMs < startedAt) return false;
	}
	return fetch(WEB_URL).then(
		() => true,
		() => false,
	);
}
while (!(await ready())) await sleep(100);

let electron;
function startElectron() {
	electron = run("node", ["scripts/start-electron.mjs"], {
		cwd: desktopDir,
		env: { ...process.env, CODEWORK_WEB_URL: WEB_URL },
	});
	// Quitting the app window ends the dev session; restarts are not quits.
	const current = electron;
	current.on("exit", () => {
		if (electron === current) shutdown();
	});
}

let restartTimer;
watch(outDir, (_event, file) => {
	if (file !== "main.cjs" && file !== "preload.cjs") return;
	clearTimeout(restartTimer);
	restartTimer = setTimeout(() => {
		const previous = electron;
		if (previous === undefined) return;
		electron = undefined;
		stop(previous);
		previous.once("exit", startElectron);
	}, 100);
});

startElectron();
