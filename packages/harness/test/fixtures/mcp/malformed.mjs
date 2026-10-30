// Hand-written stdio server sending list pages that stretch the spec; run as `node malformed.mjs`.
// MCP_MALFORMED picks the variant: "null" / "empty" (tools/list ends with nextCursor null / ""),
// "duplicate" (tools/list repeats its cursor), "skipped" (tools the SDK rejects among valid ones; calling
// `fix` repairs one and breaks another), "resources" (well-formed entries with extra fields) or "unnamed"
// (resources and templates without names).
import { createInterface } from "node:readline";

const variant = process.env.MCP_MALFORMED;
const end = variant === "empty" ? "" : null;
const tool = (name) => ({ name, inputSchema: { type: "object" } });
const text = (value) => ({ content: [{ type: "text", text: value }] });
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

let fixed = false;
const skipped = () => [
	tool("good"),
	tool("scalar"),
	tool("bare"),
	tool("fix"),
	{
		name: "typed",
		inputSchema: { type: "object" },
		outputSchema: { anyOf: [{ type: "string" }, { type: "number" }] },
	},
	fixed ? tool("bad") : { name: "bad" },
	...(fixed ? [{ name: "worse", inputSchema: { type: "string" } }] : []),
	{ inputSchema: { type: "object" } },
];
const call = (name) => {
	switch (name) {
		case "scalar":
			return { content: [{ type: "text", text: "42" }], structuredContent: 42 };
		case "bare":
			return { structuredContent: { ok: true } };
		case "fix":
			fixed = true;
			send({ method: "notifications/tools/list_changed" });
			return text("fixed");
		default:
			return text(name);
	}
};

const answer = (method, params) => {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: params.protocolVersion,
				capabilities: variant === "resources" || variant === "unnamed" ? { resources: {} } : { tools: {} },
				serverInfo: { name: "malformed-fixture", version: "1.0.0" },
			};
		case "tools/list":
			if (variant === "skipped") return { tools: skipped() };
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
		case "tools/call":
			return call(params.name);
		default:
			return {};
	}
};

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	const message = JSON.parse(line);
	if (message.id === undefined || message.method === undefined) continue;
	send({ id: message.id, result: answer(message.method, message.params) });
}
