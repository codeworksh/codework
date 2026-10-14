// Stdio MCP server for the session test; run as `node session.mjs`.
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const object = (properties = {}, required = []) => ({ type: "object", properties, required });
const text = (value) => ({ content: [{ type: "text", text: String(value) }] });

const server = new Server(
	{ name: "session-fixture", version: "1.0.0" },
	{ capabilities: { tools: {}, resources: {} } },
);
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
		{ name: "cwd", description: "The server's working directory.", inputSchema: object() },
		{ name: "link", description: "Point at a resource.", inputSchema: object() },
		{ name: "big", description: "More text than the model is shown.", inputSchema: object() },
	],
}));

const resources = {
	"": {
		resources: [
			{ uri: "fixture://notes.txt", name: "notes", mimeType: "text/plain" },
			{ uri: "ui://widget", name: "widget" },
		],
		nextCursor: "page-2",
	},
	"page-2": { resources: [{ uri: "fixture://data.bin", name: "data", mimeType: "application/octet-stream" }] },
};
const contents = {
	"fixture://notes.txt": [{ uri: "fixture://notes.txt", mimeType: "text/plain", text: "the notes" }],
	"fixture://data.bin": [{ uri: "fixture://data.bin", mimeType: "application/octet-stream", blob: "AAECAw==" }],
};
server.setRequestHandler("resources/list", (request) => resources[request.params?.cursor ?? ""]);
server.setRequestHandler("resources/templates/list", () => ({
	resourceTemplates: [{ uriTemplate: "fixture://notes/{day}", name: "daily notes" }],
}));
server.setRequestHandler("resources/read", (request) => ({ contents: contents[request.params.uri] ?? [] }));
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
		case "cwd":
			return text(process.cwd());
		case "link":
			return {
				content: [
					{ type: "resource_link", uri: "fixture://notes.txt", name: "notes", mimeType: "text/plain", size: 9 },
				],
			};
		case "big":
			return text(`start ${"x".repeat(30 * 1024)} end`);
		case "my-tool.v2":
			return { content: [], structuredContent: { version: 2 } };
		default:
			throw new Error(`unknown tool ${request.params.name}`);
	}
});

await server.connect(new StdioServerTransport());
