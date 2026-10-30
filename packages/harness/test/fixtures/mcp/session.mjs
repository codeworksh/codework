// Stdio MCP server for the session test; run as `node session.mjs`.
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { appendFileSync, existsSync } from "node:fs";

// E2E_STARTS: a file that gets each start's pid on a line. E2E_GATE: while this file exists, exit at
// once. E2E_HOLD: while this file exists, wait before answering the handshake. E2E_DELAY: milliseconds
// to wait before answering it.
if (process.env.E2E_STARTS) appendFileSync(process.env.E2E_STARTS, `${process.pid}\n`);
if (process.env.E2E_GATE && existsSync(process.env.E2E_GATE)) {
	process.stderr.write("gate closed\n");
	process.exit(1);
}
while (process.env.E2E_HOLD && existsSync(process.env.E2E_HOLD))
	await new Promise((resolve) => setTimeout(resolve, 20));
if (process.env.E2E_DELAY) await new Promise((resolve) => setTimeout(resolve, Number(process.env.E2E_DELAY)));

const object = (properties = {}, required = []) => ({ type: "object", properties, required });
const text = (value) => ({ content: [{ type: "text", text: String(value) }] });

const server = new Server({ name: "session-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler("tools/list", () => ({
	tools: [
		{
			name: "echo",
			description: "Echo text back, prefixed with the configured greeting.",
			inputSchema: object({ text: { type: "string", description: "What to echo." } }, ["text"]),
		},
		{
			name: "args",
			description: "The arguments as received.",
			inputSchema: {
				...object({ word: { type: "string", pattern: "^[a-z]+$" }, limit: { type: "integer" } }, ["word"]),
				additionalProperties: false,
			},
		},
		{ name: "fail", description: "Answer with an error result.", inputSchema: object() },
		{ name: "pid", description: "The server's process id.", inputSchema: object() },
		{ name: "crash", description: "Exit while the call is running.", inputSchema: object() },
		{ name: "my-tool.v2", inputSchema: { type: "object" } },
		{ name: "secret", description: "Never declared.", inputSchema: object() },
		{ name: "bye", description: "Answer, then exit while idle.", inputSchema: object() },
	],
}));
server.setRequestHandler("tools/call", (request) => {
	const args = request.params.arguments ?? {};
	switch (request.params.name) {
		case "echo":
			return text(`${process.env.E2E_GREETING}: ${String(args.text)}`);
		case "args":
			return text(JSON.stringify(args));
		case "fail":
			return { isError: true, content: [{ type: "text", text: "the fixture refused" }] };
		case "pid":
			return text(process.pid);
		case "crash":
			process.stderr.write("fatal: e2e fixture crashed on purpose\n");
			setTimeout(() => process.exit(3), 20);
			return new Promise(() => {});
		case "bye":
			setTimeout(() => process.exit(0), 20);
			return text("bye");
		case "my-tool.v2":
			return { content: [], structuredContent: { version: 2 } };
		default:
			throw new Error(`unknown tool ${request.params.name}`);
	}
});

await server.connect(new StdioServerTransport());
