/* @effect-diagnostics nodeBuiltinImport:off -- this suite spawns the CLI and serves a fake provider. */
/* @effect-diagnostics globalTimers:off -- the subprocess deadline runs outside any Effect. */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vite-plus/test";

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const models = fileURLToPath(new URL("../../../models.gen.json", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/mcp-echo.mjs", import.meta.url));

interface ChatRequest {
	readonly tools?: ReadonlyArray<{ readonly function: { readonly name: string; readonly parameters: unknown } }>;
	readonly messages: ReadonlyArray<{ readonly role: string; readonly content?: unknown }>;
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

/** The first request calls the MCP tool; the one carrying its result repeats that result as the answer. */
const provider = async () => {
	const requests: ChatRequest[] = [];
	const server = createServer(async (request, response) => {
		const body = JSON.parse(await read(request)) as ChatRequest;
		requests.push(body);
		response.writeHead(200, { "content-type": "text/event-stream" });
		const result = body.messages.find((message) => message.role === "tool");
		if (result !== undefined) {
			const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
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
						tool_calls: [
							{
								index: 0,
								id: "call_mcp",
								type: "function",
								function: { name: "mcp__fixture__echo", arguments: '{"text":"from the cli"}' },
							},
						],
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

const runCli = (args: ReadonlyArray<string>, options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv }) =>
	new Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }>(
		(resolve, reject) => {
			const child = spawn(process.execPath, ["--conditions=development", cli, ...args], options);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (data: Buffer) => (stdout += data.toString("utf8")));
			child.stderr.on("data", (data: Buffer) => (stderr += data.toString("utf8")));
			const deadline = setTimeout(() => child.kill("SIGKILL"), 45_000);
			child.on("error", reject);
			child.on("close", (status) => {
				clearTimeout(deadline);
				resolve({ status, stdout, stderr });
			});
		},
	);

it("codework run calls a tool of a stdio MCP server from mcp.json, and stops the server on exit", async () => {
	const home = mkdtempSync(join(tmpdir(), "codework-cli-mcp-"));
	onTestFinished(() => rmSync(home, { recursive: true, force: true }));
	const project = join(home, "project");
	const settings = join(home, "settings");
	mkdirSync(project);
	mkdirSync(settings);
	const fake = await provider();
	writeFileSync(
		join(settings, "settings.jsonc"),
		JSON.stringify({
			model: { provider: "mcp", id: "mcp-model" },
			models: [
				{
					id: "mcp-model",
					name: "mcp-model",
					provider: { id: "mcp", name: "Mcp", source: "config", env: [] },
					baseUrl: `${fake.url}/v1`,
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
	// `mcp.json` sits next to the user settings the run reads.
	writeFileSync(
		join(settings, "mcp.json"),
		JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture] } } }),
	);

	const result = await runCli(
		["--home", home, "--database", ":memory:", "--user-config-dir", settings, "run", "Echo something."],
		{ cwd: project, env: { ...process.env, HOME: home, CODEWORK_MODELS_FILE: models } },
	);
	expect(result.status, result.stderr).toBe(0);

	const answer = /echo: from the cli \(pid (\d+), cwd ([^)]+)\)/.exec(result.stdout);
	expect(answer, result.stdout).not.toBeNull();
	const [, pid, cwd] = answer!;
	// The server ran on this machine, in the session's directory, and is gone once the CLI exits.
	expect(cwd).toBe(realpathSync(project));
	expect(() => process.kill(Number(pid), 0)).toThrow();

	const declared = fake.requests[0]?.tools?.find((tool) => tool.function.name === "mcp__fixture__echo");
	await expect(
		`${JSON.stringify(
			{
				requests: fake.requests.length,
				declared: declared?.function,
				answer: answer![0].replace(pid!, "<pid>").replace(cwd!, "<project>"),
			},
			null,
			"\t",
		)}\n`,
	).toMatchFileSnapshot("./__artifacts__/cli.mcp.json");
}, 60_000);
