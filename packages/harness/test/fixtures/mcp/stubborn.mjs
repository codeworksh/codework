// Answers initialize, then ignores stdin EOF and SIGTERM; so does the grandchild it spawns.
// The grandchild pid is reported through the initialize instructions.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

process.on("SIGTERM", () => {});
const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
	stdio: "ignore",
});
setInterval(() => {}, 1000);

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
	const message = JSON.parse(line);
	if (message.method !== "initialize") return;
	const result = {
		protocolVersion: message.params.protocolVersion,
		capabilities: {},
		serverInfo: { name: "stubborn-fixture", version: "1.0.0" },
		instructions: JSON.stringify({ server: process.pid, grandchild: grandchild.pid }),
	};
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
});
