// Tools shared by the stdio fixture and the in-process streamable HTTP fixture.
import { spawn } from "node:child_process";

// One transparent pixel.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const sleep = (ms, signal) =>
	new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		});
	});
const text = (value) => ({
	content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
});

const tools = [
	"echo",
	"mixed",
	"structured",
	"crash",
	"progress",
	"slow",
	"hang",
	"cancelled",
	"roots",
	"capabilities",
	"spawn",
	"frame",
	"exit",
	"huge",
	"log",
	"stderr-child",
]
	.map((name) => ({ name, inputSchema: { type: "object" } }))
	.concat(
		["typed-missing", "typed-mismatch"].map((name) => ({
			name,
			inputSchema: { type: "object" },
			outputSchema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
		})),
	);

/** Installs the fixture tools on a low-level SDK `Server`. */
export const install = (server) => {
	const cancelled = [];

	let listed = false;
	server.setRequestHandler("tools/list", async () => {
		// MCP_FIXTURE_CHANGE_ON_LIST: the list changes while the first listing is answered.
		if (process.env.MCP_FIXTURE_CHANGE_ON_LIST && !listed) await server.sendToolListChanged();
		listed = true;
		return { tools };
	});
	server.setRequestHandler("tools/call", async (request, ctx) => {
		const args = request.params.arguments ?? {};
		const signal = ctx.mcpReq.signal;
		switch (request.params.name) {
			case "echo":
				return text(String(args.text));
			case "mixed":
				return {
					content: [
						{ type: "text", text: "hello" },
						{ type: "image", data: PNG, mimeType: "image/png" },
						{
							type: "resource",
							resource: { uri: "file:///notes.txt", mimeType: "text/plain", text: "embedded notes" },
						},
						{ type: "resource", resource: { uri: "file:///pixel.png", mimeType: "image/png", blob: PNG } },
						{ type: "resource", resource: { uri: "file:///data.bin", blob: "AAEC" } },
						{ type: "audio", data: "AAAA", mimeType: "audio/wav" },
						{ type: "resource_link", name: "readme", uri: "file:///README.md" },
						// No provider takes SVG inline.
						{ type: "image", data: Buffer.from("<svg/>").toString("base64"), mimeType: "image/svg+xml" },
					],
				};
			case "structured":
				return { content: [], structuredContent: { answer: 42, items: ["a", "b"] } };
			case "crash":
				process.stderr.write("fatal: fixture crashed on purpose\n");
				setTimeout(() => process.exit(3), 20);
				return new Promise(() => {});
			case "progress": {
				const token = request.params._meta?.progressToken;
				const ms = Number(args.ms);
				const every = Number(args.every);
				for (let elapsed = 0, step = 1; elapsed < ms; elapsed += every, step++) {
					await sleep(every, signal);
					if (token !== undefined)
						await ctx.mcpReq.notify({
							method: "notifications/progress",
							params: { progressToken: token, progress: step },
						});
				}
				return text("progress done");
			}
			case "slow":
				await sleep(Number(args.ms), signal);
				return text("slow done");
			case "hang": {
				// Acknowledges entering through progress and the cancellation through a log message.
				const token = request.params._meta?.progressToken;
				if (token !== undefined)
					await ctx.mcpReq.notify({
						method: "notifications/progress",
						params: { progressToken: token, progress: 1 },
					});
				await new Promise((resolve) =>
					signal.addEventListener("abort", () => {
						cancelled.push(String(signal.reason?.message ?? signal.reason ?? "aborted"));
						resolve();
					}),
				);
				await server.sendLoggingMessage({ level: "info", data: "hang cancelled" });
				return text("hang aborted");
			}
			case "cancelled":
				return text({ cancelled: cancelled.length });
			case "roots":
				return text(await server.listRoots());
			case "capabilities":
				return text(server.getClientCapabilities() ?? {});
			case "spawn": {
				const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
				return text({ server: process.pid, grandchild: child.pid });
			}
			case "frame":
				// An unparsable line, then a CRLF-terminated notification the client must still see.
				process.stdout.write("this is not json\n");
				process.stdout.write(
					`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\r\n`,
				);
				return text("framed");
			case "exit":
				setTimeout(() => process.exit(0), 20);
				return text("bye");
			case "huge":
				// One 17 MiB line that never ends: more than the client's 16 MiB frame limit.
				process.stdout.write("x".repeat(17 * 1024 * 1024));
				return new Promise(() => {});
			case "stderr-child": {
				// The grandchild inherits only stderr; the server then exits on its own.
				const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
					stdio: ["ignore", "ignore", "inherit"],
				});
				setTimeout(() => process.exit(0), 50);
				return text({ server: process.pid, grandchild: child.pid });
			}
			case "log":
				await server.sendLoggingMessage({ level: "info", data: "first line\nsecond line" });
				await server.sendLoggingMessage({ level: "warning", logger: "db", data: { query: "select 1", ms: 3 } });
				return text("logged");
			case "typed-missing":
				return text("no structured content");
			case "typed-mismatch":
				return { content: [{ type: "text", text: "wrong shape" }], structuredContent: { answer: "nope" } };
			default:
				throw new Error(`unknown tool ${request.params.name}`);
		}
	});
};
