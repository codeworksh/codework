// Stdio MCP server for the session test; run as `node session.mjs`.
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

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
