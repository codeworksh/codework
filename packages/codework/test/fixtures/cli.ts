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

const chunk = (choice: object) => ({
	id: "chatcmpl-mcp",
	object: "chat.completion.chunk",
	created: 1,
	model: "mcp-model",
	choices: [{ index: 0, ...choice }],
});

/** One provider response as it streams: `send` writes a chunk carrying `delta`, `finish` ends it. */
export interface Reply {
	readonly send: (delta: object) => void;
	readonly finish: (reason: string) => void;
}

/**
 * An OpenAI-compatible provider whose `reply` writes each response (`index` counts requests from
 * 0). A response it never finishes hangs until the client goes away.
 */
export const streaming = async (reply: (body: ChatRequest, response: Reply, index: number) => void) => {
	const requests: ChatRequest[] = [];
	const server = createServer(async (request, response) => {
		const body = JSON.parse(await read(request)) as ChatRequest;
		requests.push(body);
		response.writeHead(200, { "content-type": "text/event-stream" });
		reply(
			body,
			{
				send: (delta) => response.write(`data: ${JSON.stringify(chunk({ delta }))}\n\n`),
				finish: (reason) =>
					response.end(`data: ${JSON.stringify(chunk({ delta: {}, finish_reason: reason }))}\n\ndata: [DONE]\n\n`),
			},
			requests.length - 1,
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	onTestFinished(
		() =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	);
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
};

/** The assistant delta making `calls`, all in one turn. */
export const toolCalls = (calls: ReadonlyArray<ToolCall>) => ({
	role: "assistant",
	tool_calls: calls.map((call, index) => ({
		index,
		id: `call_${index}`,
		type: "function",
		function: { name: call.name, arguments: JSON.stringify(call.arguments) },
	})),
});

/**
 * A request without tool results makes the calls `calls()` names, all in one turn; the request
 * carrying their results answers with them, joined by ` | `.
 */
export const provider = (calls: () => ReadonlyArray<ToolCall>) =>
	streaming((body, response) => {
		const results = body.messages.filter((message) => message.role === "tool");
		if (results.length > 0) {
			const text = results
				.map((result) => (typeof result.content === "string" ? result.content : JSON.stringify(result.content)))
				.join(" | ");
			response.send({ role: "assistant", content: `Tool said: ${text}` });
			response.finish("stop");
			return;
		}
		response.send(toolCalls(calls()));
		response.finish("tool_calls");
	});

/** Answers every request with `text`, cut off at the output token limit. */
export const truncating = (text: string) =>
	streaming((_body, response) => {
		response.send({ role: "assistant", content: text });
		response.finish("length");
	});

/** `settings.jsonc` in `directory`, choosing the fake provider's one model; `extra` adds settings. */
export const writeSettings = (directory: string, url: string, extra: object = {}) =>
	writeFileSync(
		join(directory, "settings.jsonc"),
		JSON.stringify({
			...extra,
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

/** Runs the CLI from source; `onStderr` sees its standard error as it arrives. */
export const runCli = (
	args: ReadonlyArray<string>,
	options: {
		readonly cwd: string;
		readonly env: NodeJS.ProcessEnv;
		readonly onStderr?: (text: string) => void;
		/** The child process, for a test that signals it or types into it. */
		readonly onSpawn?: (child: { kill: (signal: NodeJS.Signals) => void; stdin: Writable }) => void;
	},
) =>
	new Promise<Result>((resolve, reject) => {
		const child = spawn(process.execPath, ["--conditions=development", cli, ...args], {
			cwd: options.cwd,
			env: options.env,
		});
		options.onSpawn?.(child);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data: Buffer) => (stdout += data.toString("utf8")));
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

export interface Served {
	/** The RPC endpoint the server announced. */
	readonly url: string;
	/** SIGKILLs the server, as a host dying would, and resolves once it is gone. */
	readonly kill: () => Promise<void>;
	/** SIGTERMs the server, a clean shutdown, and resolves once it is gone. */
	readonly stop: () => Promise<void>;
}

/** Starts `codework serve` from source on an ephemeral port; resolves once it listens. */
export const serveCli = (
	args: ReadonlyArray<string>,
	options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
) =>
	new Promise<Served>((resolve, reject) => {
		const child = spawn(process.execPath, ["--conditions=development", cli, ...args, "serve", "--port", "0"], {
			cwd: options.cwd,
			env: options.env,
		});
		const exited = new Promise<void>((done) => child.on("exit", () => done()));
		const signal = (name: NodeJS.Signals) => () => {
			if (child.exitCode === null && child.signalCode === null) child.kill(name);
			return exited;
		};
		const kill = signal("SIGKILL");
		onTestFinished(kill);
		let output = "";
		const deadline = setTimeout(() => {
			void kill();
			reject(new Error(`codework serve did not start:\n${output}`));
		}, 30_000);
		const listen = (data: Buffer) => {
			output += data.toString("utf8");
			const url = /listening on (ws:\/\/\S+)/.exec(output)?.[1];
			if (url === undefined) return;
			clearTimeout(deadline);
			resolve({ url, kill, stop: signal("SIGTERM") });
		};
		child.stdout.on("data", listen);
		child.stderr.on("data", (data: Buffer) => (output += data.toString("utf8")));
		child.on("error", reject);
		child.on("exit", () => {
			clearTimeout(deadline);
			reject(new Error(`codework serve exited:\n${output}`));
		});
	});
