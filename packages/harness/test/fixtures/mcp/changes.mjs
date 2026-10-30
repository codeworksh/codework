// Stdio MCP server whose tool list changes when its tools are called; run as `node changes.mjs`.
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const text = (value) => ({ content: [{ type: "text", text: String(value) }] });
const tool = (name) => ({ name, inputSchema: { type: "object" } });

let names = ["old", "swap", "burst"];
// The next listing waits this long before answering, with the list as it was asked for.
let slow = 0;
let listed = () => {};

const server = new Server({ name: "changes-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler("tools/list", async () => {
	const snapshot = names.map(tool);
	const delay = slow;
	slow = 0;
	listed();
	if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
	return { tools: snapshot };
});
server.setRequestHandler("tools/call", async (request) => {
	switch (request.params.name) {
		// Withdraws `old` and offers `new`, answering once the client had time to take the new list in.
		case "swap": {
			names = names.filter((name) => name !== "old").concat("new");
			const relisted = new Promise((resolve) => (listed = resolve));
			await server.sendToolListChanged();
			await relisted;
			await new Promise((resolve) => setTimeout(resolve, 100));
			return text("swapped");
		}
		// Two changes in a row: the first listing answers last, with `stale`; the second one first, with `fresh`.
		case "burst": {
			names = names.concat("stale");
			slow = 500;
			const first = new Promise((resolve) => (listed = resolve));
			await server.sendToolListChanged();
			await first;
			names = names.filter((name) => name !== "stale").concat("fresh");
			await server.sendToolListChanged();
			return text("burst");
		}
		default:
			return text(request.params.name);
	}
});

await server.connect(new StdioServerTransport());
