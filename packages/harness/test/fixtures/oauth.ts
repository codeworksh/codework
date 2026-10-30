/**
 * An OAuth-protected Streamable HTTP MCP server with its own authorization server: metadata, a
 * refresh-token grant that rotates the refresh token, and `/mcp` with one `whoami` tool. Signing in
 * is out of scope; a case seeds the tokens with `issue`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

const read = async (request: IncomingMessage) => {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
};

const json = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
	void response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

export const oauth = () => {
	const state = {
		/** What happened, in order. */
		log: [] as Array<Record<string, unknown>>,
		/** Access tokens still accepted. */
		access: new Set<string>(),
		refresh: undefined as string | undefined,
		issued: 0,
		/** Awaited before the token endpoint answers. */
		beforeToken: undefined as (() => Promise<void>) | undefined,
	};

	const issue = () => {
		state.issued += 1;
		const access = `access-${state.issued}`;
		state.refresh = `refresh-${state.issued}`;
		state.access.add(access);
		return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: state.refresh };
	};

	const handler = async (request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
		const base = url.origin;
		switch (url.pathname) {
			case "/.well-known/oauth-protected-resource/mcp":
				return json(response, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
			case "/.well-known/oauth-authorization-server":
				return json(response, 200, {
					issuer: base,
					authorization_endpoint: `${base}/authorize`,
					token_endpoint: `${base}/token`,
					response_types_supported: ["code"],
					grant_types_supported: ["authorization_code", "refresh_token"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
				});
			case "/token": {
				const form = new URLSearchParams(await read(request));
				const presented = form.get("refresh_token");
				state.log.push({ token: form.get("grant_type"), presented });
				await state.beforeToken?.();
				if (form.get("grant_type") !== "refresh_token" || presented !== state.refresh)
					return json(response, 400, { error: "invalid_grant", error_description: "refresh token revoked" });
				state.access.clear();
				const issued = issue();
				state.log.push({ issued: issued.access_token });
				return json(response, 200, issued);
			}
			case "/mcp": {
				const header = request.headers.authorization ?? "";
				const token = header.startsWith("Bearer ") ? header.slice(7) : undefined;
				if (request.method === "GET") return void response.writeHead(405).end();
				if (request.method === "DELETE") return void response.writeHead(200).end();
				const body = JSON.parse(await read(request)) as { id?: number; method: string; params?: unknown };
				if (token === undefined || !state.access.has(token)) {
					state.log.push({ mcp: body.method, token, refused: true });
					return void response
						.writeHead(401, {
							"www-authenticate": `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
						})
						.end("unauthorized");
				}
				if (body.method.startsWith("notifications/")) state.log.push({ mcp: body.method, token });
				if (body.id === undefined) return void response.writeHead(202).end();
				if (body.method === "tools/call") state.log.push({ mcp: body.method, token });
				const result =
					body.method === "initialize"
						? {
								protocolVersion: (body.params as { protocolVersion?: string } | undefined)?.protocolVersion,
								capabilities: { tools: {} },
								serverInfo: { name: "oauth-fixture", version: "1.0.0" },
							}
						: body.method === "tools/list"
							? { tools: [{ name: "whoami", inputSchema: { type: "object" } }] }
							: body.method === "tools/call"
								? { content: [{ type: "text", text: `called with ${token}` }] }
								: {};
				return json(response, 200, { jsonrpc: "2.0", id: body.id, result }, { "mcp-session-id": "oauth-session" });
			}
			default:
				return void response.writeHead(404).end();
		}
	};

	return { state, issue, handler };
};
