import { spawn } from "node:child_process";

const children = [];
let shuttingDown = false;

function start(command, args) {
	const child = spawn(command, args, {
		stdio: "inherit",
		env: process.env,
	});

	children.push(child);

	child.on("exit", (code, signal) => {
		if (shuttingDown) {
			return;
		}

		shuttingDown = true;
		for (const otherChild of children) {
			if (otherChild !== child && !otherChild.killed) {
				otherChild.kill("SIGTERM");
			}
		}

		if (signal) {
			process.kill(process.pid, signal);
			return;
		}

		process.exit(code ?? 0);
	});
}

function shutdown(signal) {
	if (shuttingDown) {
		return;
	}

	shuttingDown = true;
	for (const child of children) {
		if (!child.killed) {
			child.kill(signal);
		}
	}
}

start("pnpm", ["run", "dev:bundle"]);
start("pnpm", ["run", "dev:electron"]);

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
