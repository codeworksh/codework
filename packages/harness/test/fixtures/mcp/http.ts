import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { Effect } from "effect";
// @ts-expect-error plain .mjs fixture shared with the stdio server, which runs without a TS loader
import { install } from "./tools.mjs";

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

/** Serves `handler` on 127.0.0.1 at an ephemeral port for the calling scope; yields the `/mcp` URL. */
export const listen = (handler: Handler) =>
	Effect.acquireRelease(
		Effect.callback<ReturnType<typeof createServer>>((resume) => {
			const server = createServer((request, response) => {
				handler(request, response).catch((error: unknown) => {
					if (!response.headersSent) response.writeHead(500);
					response.end(String(error));
				});
			});
			server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
		}),
		(server) =>
			Effect.callback<void>((resume) => {
				server.closeAllConnections();
				server.close(() => resume(Effect.void));
			}),
	).pipe(Effect.map((server) => new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)));

const readBody = async (request: IncomingMessage) => {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
};

/** A single-session streamable HTTP server running the shared fixture tools on the real SDK transport. */
export const sdk = async (): Promise<Handler> => {
	const server = new Server({ name: "http-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
	install(server);
	const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => "fixture-session" });
	await server.connect(transport);
	return async (request, response) => {
		const headers = new Headers();
		for (let index = 0; index < request.rawHeaders.length; index += 2)
			headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!);
		const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request);
		const answer = await transport.handleRequest(
			new Request(new URL(request.url ?? "/", "http://127.0.0.1"), {
				method: request.method ?? "GET",
				headers,
				...(body === undefined ? {} : { body }),
			}),
		);
		response.writeHead(answer.status, Object.fromEntries(answer.headers));
		if (!answer.body) return void response.end();
		const reader = answer.body.getReader();
		response.on("close", () => void reader.cancel().catch(() => {}));
		while (true) {
			const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }));
			if (chunk.done) break;
			response.write(chunk.value);
		}
		response.end();
	};
};

/** A scripted answer: a status with a text body, or no answer at all. */
export type Reply = { readonly status: number; readonly body: string } | "hang";

/** Requests a hand-written server saw, as `METHOD rpc-method`. */
export interface Raw {
	readonly handler: Handler;
	readonly seen: string[];
	/** Answer every request carrying a session id with 404, as a server that lost the session. */
	forget: boolean;
}

/** A hand-written streamable HTTP server for raw status scenarios. */
export const raw = (
	options: {
		readonly failInitialize?: number;
		readonly unauthorized?: boolean;
		/** Protocol version to answer initialize with, instead of echoing the client's. */
		readonly protocolVersion?: string;
		/** Overrides the answer to a request, keyed as in `seen`; `undefined` answers normally. */
		readonly script?: (request: string) => Reply | undefined;
	} = {},
): Raw => {
	let failures = options.failInitialize ?? 0;
	const state: Raw = {
		seen: [],
		forget: false,
		handler: async (request, response) => {
			// An OAuth-protected server: every MCP request is refused, and there is no discovery metadata.
			if (options.unauthorized) {
				state.seen.push(`${request.method} ${new URL(request.url ?? "/", "http://127.0.0.1").pathname}`);
				await readBody(request);
				if (request.url?.startsWith("/mcp") !== true) return void response.writeHead(404).end();
				response.writeHead(401, { "www-authenticate": 'Bearer error="invalid_token"' });
				return void response.end("unauthorized");
			}
			const body = request.method === "POST" ? (JSON.parse((await readBody(request)).toString()) as Rpc) : undefined;
			const key = body?.method ? `${request.method} ${body.method}` : `${request.method}`;
			state.seen.push(key);
			const scripted = options.script?.(key);
			if (scripted === "hang") return;
			if (scripted !== undefined)
				return void response.writeHead(scripted.status, { "content-type": "text/plain" }).end(scripted.body);
			if (state.forget && request.headers["mcp-session-id"] !== undefined) {
				response.writeHead(404, { "content-type": "text/plain" });
				return void response.end("session not found");
			}
			if (request.method === "GET") return void response.writeHead(405).end();
			if (request.method === "DELETE") return void response.writeHead(200).end();
			if (body === undefined || body.id === undefined) return void response.writeHead(202).end();
			if (body.method === "initialize" && failures > 0) {
				failures--;
				return void response.writeHead(503, { "content-type": "text/plain" }).end("overloaded");
			}
			const result =
				body.method === "initialize"
					? {
							protocolVersion: options.protocolVersion ?? body.params?.protocolVersion,
							capabilities: { tools: {} },
							serverInfo: { name: "raw-fixture", version: "1.0.0" },
						}
					: body.method === "tools/list"
						? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
						: body.method === "tools/call"
							? { content: [{ type: "text", text: "called" }] }
							: {};
			response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "raw-session" });
			response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
		},
	};
	return state;
};

interface Rpc {
	readonly id?: number | string;
	readonly method?: string;
	readonly params?: { readonly protocolVersion?: string };
}
