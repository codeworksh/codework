// Stdio MCP fixture server built on the SDK; run as `node server.mjs`.
// MCP_FIXTURE picks the variant: unset (tools with listChanged), "plain" (tools without listChanged)
// or "resources" (resources only, paginated, without a templates/list handler).
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { install } from "./tools.mjs";

const variant = process.env.MCP_FIXTURE;
const capabilities =
	variant === "resources"
		? { resources: { listChanged: true } }
		: variant === "plain"
			? { tools: {} }
			: { tools: { listChanged: true }, logging: {} };
const server = new Server(
	{ name: "stdio-fixture", version: "1.0.0" },
	{ capabilities, instructions: "  Use the echo tool.  \n" },
);

if (variant === "resources") {
	const pages = {
		"": { resources: [{ uri: "fixture://one", name: "one" }], nextCursor: "page-2" },
		"page-2": { resources: [{ uri: "fixture://changed", name: "changed" }] },
	};
	server.setRequestHandler("resources/list", (request) => pages[request.params?.cursor ?? ""]);
	server.setRequestHandler("resources/read", async (request) => {
		const uri = request.params.uri;
		if (uri === "fixture://changed") await server.sendResourceListChanged();
		return { contents: [{ uri, mimeType: "text/plain", text: `contents of ${uri}` }] };
	});
} else install(server);

await server.connect(new StdioServerTransport());
