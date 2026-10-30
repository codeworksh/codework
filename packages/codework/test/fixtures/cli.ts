/* @effect-diagnostics nodeBuiltinImport:off -- these helpers spawn the CLI and serve a fake provider. */
/* @effect-diagnostics globalTimers:off -- the subprocess deadline runs outside any Effect. */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Writable } from "node:stream";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vite-plus/test";

const cli = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
export const models = fileURLToPath(new URL("../../../../models.gen.json", import.meta.url));

export interface ChatRequest {
	readonly tools?: ReadonlyArray<{ readonly function: { readonly name: string; readonly parameters: unknown } }>;
	readonly messages: ReadonlyArray<{ readonly role: string; readonly content?: unknown }>;
}

export interface ToolCall {
	readonly name: string;
	readonly arguments: object;
}

const read = (request: IncomingMessage) =>
	new Promise<string>((resolve, reject) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});

const sse = (chunks: ReadonlyArray<object>) =>
	`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
const chunk = (choice: object) => ({
	id: "chatcmpl-mcp",
	object: "chat.completion.chunk",
	created: 1,
	model: "mcp-model",
	choices: [{ index: 0, ...choice }],
});

/**
 * An OpenAI-compatible provider. A request without tool results makes the calls `calls()` names,
 * all in one turn; the request carrying their results answers with them, joined by ` | `.
 */
export const provider = async (calls: () => ReadonlyArray<ToolCall>) => {
	const requests: ChatRequest[] = [];
	const server = createServer(async (request, response) => {
		const body = JSON.parse(await read(request)) as ChatRequest;
		requests.push(body);
		response.writeHead(200, { "content-type": "text/event-stream" });
		const results = body.messages.filter((message) => message.role === "tool");
		if (results.length > 0) {
			const text = results
				.map((result) => (typeof result.content === "string" ? result.content : JSON.stringify(result.content)))
				.join(" | ");
			response.end(
				sse([
					chunk({ delta: { role: "assistant", content: `Tool said: ${text}` } }),
					chunk({ delta: {}, finish_reason: "stop" }),
				]),
			);
			return;
		}
		response.end(
			sse([
				chunk({
					delta: {
						role: "assistant",
						tool_calls: calls().map((call, index) => ({
							index,
							id: `call_${index}`,
							type: "function",
							function: { name: call.name, arguments: JSON.stringify(call.arguments) },
						})),
					},
				}),
				chunk({ delta: {}, finish_reason: "tool_calls" }),
			]),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
};

/** `settings.jsonc` in `directory`, choosing the fake provider's one model. */
export const writeSettings = (directory: string, url: string) =>
	writeFileSync(
		join(directory, "settings.jsonc"),
		JSON.stringify({
			model: { provider: "mcp", id: "mcp-model" },
			models: [
				{
					id: "mcp-model",
					name: "mcp-model",
					provider: { id: "mcp", name: "Mcp", source: "config", env: [] },
					baseUrl: `${url}/v1`,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32768,
					maxTokens: 8192,
					protocol: "openai-compatible",
				},
			],
		}),
	);

export interface Result {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

// Node pipes are sockets, which `script` refuses as its input on macOS.
const terminal = fileURLToPath(new URL("./terminal.py", import.meta.url));

/**
 * Runs the CLI from source; `onStdout` and `onStderr` see each stream as it arrives. `tty` runs it
 * in a pseudo-terminal whose output, both streams, comes back as `stdout`.
 */
export const runCli = (
	args: ReadonlyArray<string>,
	options: {
		readonly cwd: string;
		readonly env: NodeJS.ProcessEnv;
		readonly tty?: boolean;
		readonly onStdout?: (text: string) => void;
		readonly onStderr?: (text: string) => void;
		/** The child process, for a test that signals it or types into it. */
		readonly onSpawn?: (child: { kill: (signal: NodeJS.Signals) => void; stdin: Writable }) => void;
	},
) =>
	new Promise<Result>((resolve, reject) => {
		const command = [process.execPath, "--conditions=development", cli, ...args];
		const child = options.tty
			? spawn("python3", ["-I", terminal, ...command], { cwd: options.cwd, env: options.env })
			: spawn(command[0]!, command.slice(1), { cwd: options.cwd, env: options.env });
		options.onSpawn?.(child);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString("utf8");
			options.onStdout?.(stdout);
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString("utf8");
			options.onStderr?.(stderr);
		});
		const deadline = setTimeout(() => child.kill("SIGKILL"), 45_000);
		child.on("error", reject);
		child.on("close", (status) => {
			clearTimeout(deadline);
			resolve({ status, stdout, stderr });
		});
	});
