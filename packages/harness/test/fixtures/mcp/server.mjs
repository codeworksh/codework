// Stdio MCP fixture server built on the SDK; run as `node server.mjs`.
// MCP_FIXTURE picks the variant: unset (tools with listChanged), "plain" (tools without listChanged),
// "resources" (resources only, paginated, without a templates/list handler) or "blank" (tools, resources
// and templates in two pages each, the second ending with a blank cursor).
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { install } from "./tools.mjs";

const variant = process.env.MCP_FIXTURE;
const capabilities =
	variant === "blank"
		? { tools: {}, resources: {} }
		: variant === "resources"
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
} else if (variant === "blank") {
	const paged = (first, second) => (request) =>
		request.params?.cursor === "page-2" ? { ...second, nextCursor: "" } : { ...first, nextCursor: "page-2" };
	const tool = (name) => ({ name, inputSchema: { type: "object" } });
	server.setRequestHandler("tools/list", paged({ tools: [tool("first")] }, { tools: [tool("second")] }));
	server.setRequestHandler(
		"resources/list",
		paged(
			{ resources: [{ uri: "fixture://one", name: "one" }] },
			{ resources: [{ uri: "fixture://two", name: "two" }] },
		),
	);
	server.setRequestHandler(
		"resources/templates/list",
		paged(
			{ resourceTemplates: [{ uriTemplate: "fixture://one/{id}", name: "one" }] },
			{ resourceTemplates: [{ uriTemplate: "fixture://two/{id}", name: "two" }] },
		),
	);
} else install(server);

// A message sent right after the handshake, before the client has listed anything.
if (capabilities.logging)
	server.oninitialized = () => void server.sendLoggingMessage({ level: "info", logger: "startup", data: "ready" });

await server.connect(new StdioServerTransport());
