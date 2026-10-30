// Stdio MCP server whose tool list changes when its tools are called; run as `node changes.mjs`.
// E2E_RELEASE: a file whose creation releases the held listing of `burst`.
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { existsSync } from "node:fs";

const text = (value) => ({ content: [{ type: "text", text: String(value) }] });
const tool = (name) => ({ name, inputSchema: { type: "object" } });

let names = ["old", "swap", "burst"];
// Whether the next listing is held until E2E_RELEASE exists, then answers with the list as it was asked for.
let hold = false;
let listed = () => {};

const server = new Server({ name: "changes-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler("tools/list", async () => {
	const snapshot = names.map(tool);
	const held = hold;
	hold = false;
	listed();
	while (held && !existsSync(process.env.E2E_RELEASE)) await new Promise((resolve) => setTimeout(resolve, 20));
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
		// Two changes in a row: the second one, to `fresh`, while the listing of the first, with `stale`, is
		// held until released.
		case "burst": {
			names = names.concat("stale");
			hold = true;
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
