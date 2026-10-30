// A minimal stdio MCP server, written against the wire protocol rather than an SDK: one JSON-RPC
// message per line in, one per line out. It offers one tool, `echo`. While the file `E2E_GATE` names
// exists, it exits at once.
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.E2E_GATE && existsSync(process.env.E2E_GATE)) {
	process.stderr.write("gate closed\n");
	process.exit(1);
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

const answer = (method, params) => {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: params.protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: "cli-fixture", version: "1.0.0" },
			};
		case "tools/list":
			return {
				tools: [
					{
						name: "echo",
						description: "Echo text back, with the directory the server runs in.",
						inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
					},
				],
			};
		case "tools/call":
			return {
				content: [
					{ type: "text", text: `echo: ${params.arguments.text} (pid ${process.pid}, cwd ${process.cwd()})` },
				],
			};
		default:
			return {};
	}
};

for await (const line of createInterface({ input: process.stdin })) {
	if (!line.trim()) continue;
	const message = JSON.parse(line);
	// Notifications carry no id and get no answer.
	if (message.id === undefined) continue;
	send({ id: message.id, result: answer(message.method, message.params ?? {}) });
}
