import { spawn } from "node:child_process";
import { cp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)));
const webuiDir = join(desktopDir, "..", "webui");
const webuiDistDir = join(webuiDir, "dist");
const rendererDistDir = join(desktopDir, "dist", "renderer");

function run(command, args, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: "inherit",
		});

		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (signal) {
				reject(new Error(`${command} ${args.join(" ")} exited with signal ${signal}`));
				return;
			}

			if (code !== 0) {
				reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? 1}`));
				return;
			}

			resolve();
		});
	});
}

await run("tsdown", [], desktopDir);
await run("pnpm", ["--filter", "@codeworksh/webui", "build"], desktopDir);
await rm(rendererDistDir, { recursive: true, force: true });
await cp(webuiDistDir, rendererDistDir, { recursive: true });
