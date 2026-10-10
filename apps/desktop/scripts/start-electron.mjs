import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronPath = createRequire(import.meta.url)("electron");

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
