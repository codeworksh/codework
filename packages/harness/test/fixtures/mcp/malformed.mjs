// Hand-written stdio server sending list pages that stretch the spec; run as `node malformed.mjs`.
// MCP_MALFORMED picks the variant: "null" / "empty" (tools/list ends with nextCursor null / ""),
// "duplicate" (tools/list repeats its cursor), "invalid" (a tool without inputSchema),
// "resources" (well-formed entries with extra fields) or "unnamed" (resources and templates without names).
import { createInterface } from "node:readline";

const variant = process.env.MCP_MALFORMED;
const end = variant === "empty" ? "" : null;
const tool = (name) => ({ name, inputSchema: { type: "object" } });

const answer = (method, params) => {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: params.protocolVersion,
				capabilities: variant === "resources" || variant === "unnamed" ? { resources: {} } : { tools: {} },
				serverInfo: { name: "malformed-fixture", version: "1.0.0" },
			};
		case "tools/list":
			if (variant === "invalid") return { tools: [tool("good"), { name: "bad" }] };
			if (variant === "duplicate") return { tools: [tool(`t-${params?.cursor ?? "start"}`)], nextCursor: "again" };
			return params?.cursor === "p2"
				? { tools: [tool("second")], nextCursor: end }
				: { tools: [tool("first")], nextCursor: "p2" };
		case "resources/list":
			return variant === "unnamed"
				? { resources: [{ uri: "file:///a.txt" }] }
				: {
						resources: [
							{
								uri: "file:///a.txt",
								name: "a",
								description: "A file",
								mimeType: "text/plain",
								_meta: { origin: "fixture" },
							},
						],
					};
		case "resources/templates/list":
			return variant === "unnamed"
				? { resourceTemplates: [{ uriTemplate: "file:///{path}" }] }
				: { resourceTemplates: [{ uriTemplate: "file:///{path}", name: "files", description: "Any file" }] };
		default:
			return {};
	}
};

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	const message = JSON.parse(line);
	if (message.id === undefined || message.method === undefined) continue;
	const result = answer(message.method, message.params);
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
}
