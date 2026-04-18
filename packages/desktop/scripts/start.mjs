import { spawn } from "node:child_process";

import { desktopDir, resolveElectronPath } from "./launch.mjs";

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(resolveElectronPath(), ["dist/electron/main.mjs"], {
	cwd: desktopDir,
	env: childEnv,
	stdio: "inherit",
});

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}

	process.exit(code ?? 0);
});
