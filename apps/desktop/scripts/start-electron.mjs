import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronBinary = createRequire(import.meta.url)("electron");
const APP_NAME = "CodeWork";

// macOS names the Dock icon after the running bundle's Info.plist, so on macOS
// Electron runs from a renamed copy of Electron.app, rebuilt when Electron changes.
function brandedElectron() {
	const source = path.resolve(electronBinary, "../../..");
	const target = path.join(desktopDir, ".electron-runtime", `${APP_NAME}.app`);
	const marker = path.join(desktopDir, ".electron-runtime", "source");
	const binary = path.join(target, "Contents", "MacOS", "Electron");
	if (existsSync(marker) && readFileSync(marker, "utf8") === source) return binary;

	rmSync(target, { recursive: true, force: true });
	// Keeps the frameworks' relative symlinks; absolute ones crash the helper processes.
	cpSync(source, target, { recursive: true, verbatimSymlinks: true });
	const plist = path.join(target, "Contents", "Info.plist");
	for (const [key, value] of [
		["CFBundleName", APP_NAME],
		["CFBundleDisplayName", APP_NAME],
		["CFBundleIdentifier", "sh.codework.desktop.dev"],
	])
		execFileSync("plutil", ["-replace", key, "-string", value, plist]);
	execFileSync("codesign", ["--force", "--deep", "--sign", "-", target]);
	writeFileSync(marker, source);
	return binary;
}

const electronPath = process.platform === "darwin" ? brandedElectron() : electronBinary;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ["."], {
	stdio: "inherit",
	cwd: desktopDir,
	env,
});

// Stay alive until Electron has quit, so callers waiting on this process never
// overlap a still-running instance.
const forward = (signal) => child.kill(signal);
process.on("SIGINT", forward);
process.on("SIGTERM", forward);

child.on("exit", (code, signal) => {
	if (signal) {
		process.off(signal, forward);
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 0);
});
