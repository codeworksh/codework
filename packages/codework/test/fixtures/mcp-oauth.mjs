/**
 * An OAuth-protected Streamable HTTP MCP server with its own authorization server, written against
 * the wire protocols: protected resource and authorization server metadata, dynamic client
 * registration, the authorization code flow with PKCE, rotating refresh tokens.
 *
 * `/mcp` takes the tokens it issued; `/keyed` takes one fixed bearer, for `auth.provider`. The
 * metadata, registration and token answers carry `null` and `""` for fields they have no value for,
 * as some real servers do. `/authorize` approves at once and redirects back.
 *
 * Options turn it into the server a case needs:
 * - `metadata: false`: no authorization server metadata at the well-known paths; it is still served
 *   at `/custom/metadata`, for `oauth.authServerMetadataUrl`.
 * - `authorizationEndpoint` / `issuer`: what the metadata claims.
 * - `iss`: sent with the authorization response; `"self"` is the real issuer.
 * - `rejectCode`: the token endpoint refuses every authorization code.
 * - `requireScope`: a tool call needs this scope too, or gets a 403 `insufficient_scope`.
 * - `deny`: `/authorize` refuses with `access_denied` and this description.
 * - `beforeToken`: awaited before the token endpoint answers.
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";

const read = (request) =>
	new Promise((resolve, reject) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});

const json = (response, status, body, headers = {}) =>
	response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

export const start = async (options = {}) => {
	const state = {
		/** What happened, in order, with the values a test can rely on. */
		log: [],
		/** Access tokens issued and still accepted, with the scope each was granted. */
		access: new Map(),
		refresh: undefined,
		refreshScope: undefined,
		issued: 0,
		client: undefined,
		pending: new Map(),
		/**
		 * What happens right after the next `tools/list`: `expire` the access tokens (a refresh still
		 * works), or `revoke` them and the refresh token (it does not).
		 */
		afterList: undefined,
		/** Every bearer token presented to `/mcp` or `/keyed`, accepted or not. */
		presented: new Set(),
	};
	let base = "";
	const scopes = (scope) => (scope ?? "").split(" ").filter(Boolean);

	const issue = (scope) => {
		state.issued += 1;
		const access = `access-${state.issued}`;
		state.refresh = `refresh-${state.issued}`;
		state.refreshScope = scope;
		state.access.set(access, scope);
		return {
			access_token: access,
			token_type: "Bearer",
			expires_in: 3600,
			refresh_token: state.refresh,
			scope: null,
			id_token: "",
		};
	};

	const metadata = () => ({
		issuer: options.issuer ?? base,
		authorization_endpoint: options.authorizationEndpoint ?? `${base}/authorize`,
		token_endpoint: `${base}/token`,
		registration_endpoint: `${base}/register`,
		response_types_supported: ["code"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: ["none"],
		scopes_supported: null,
		service_documentation: "",
	});

	const mcp = async (request, response, accepted) => {
		const header = request.headers.authorization ?? "";
		const token = header.startsWith("Bearer ") ? header.slice(7) : undefined;
		const body = request.method === "POST" ? JSON.parse(await read(request)) : undefined;
		if (token !== undefined) state.presented.add(token);
		// Not logged: which request meets a refused token first depends on the background stream.
		if (token === undefined || !accepted(token))
			return void response
				.writeHead(401, {
					"www-authenticate": `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="tools"`,
				})
				.end("unauthorized");
		if (request.method === "GET") return void response.writeHead(405).end();
		if (request.method === "DELETE") return void response.writeHead(200).end();
		if (body?.id === undefined) return void response.writeHead(202).end();
		if (
			body.method === "tools/call" &&
			options.requireScope !== undefined &&
			!scopes(state.access.get(token)).includes(options.requireScope)
		) {
			state.log.push({ mcp: "tools/call", token, insufficientScope: true });
			return void response
				.writeHead(403, {
					"www-authenticate": `Bearer error="insufficient_scope", scope="tools ${options.requireScope}", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
				})
				.end("forbidden");
		}
		const result =
			body.method === "initialize"
				? {
						protocolVersion: body.params?.protocolVersion,
						capabilities: { tools: {} },
						serverInfo: { name: "oauth-fixture", version: "1.0.0" },
					}
				: body.method === "tools/list"
					? { tools: [{ name: "whoami", description: "Which token called", inputSchema: { type: "object" } }] }
					: body.method === "tools/call"
						? { content: [{ type: "text", text: `called with ${token}` }] }
						: {};
		if (body.method === "tools/call") state.log.push({ mcp: "tools/call", token });
		if (body.method === "tools/list" && state.afterList !== undefined) {
			state.access.clear();
			if (state.afterList === "revoke") state.refresh = undefined;
			state.log.push({ [state.afterList]: true });
			state.afterList = undefined;
		}
		json(response, 200, { jsonrpc: "2.0", id: body.id, result }, { "mcp-session-id": "oauth-session" });
	};

	const server = createServer(async (request, response) => {
		const url = new URL(request.url, base);
		switch (url.pathname) {
			case "/mcp":
				return mcp(request, response, (token) => state.access.has(token));
			case "/keyed":
				return mcp(request, response, (token) => token === options.keyedToken);
			case "/.well-known/oauth-protected-resource/mcp":
				state.log.push({ metadata: "resource", query: url.search });
				return json(response, 200, {
					resource: `${base}/mcp`,
					authorization_servers: [base],
					scopes_supported: ["tools"],
					resource_name: null,
				});
			case "/.well-known/oauth-authorization-server":
			case "/.well-known/openid-configuration":
				if (options.metadata === false) return void response.writeHead(404).end();
				state.log.push({ metadata: "authorization-server", query: url.search });
				return json(response, 200, metadata());
			case "/custom/metadata":
				state.log.push({ metadata: "configured" });
				return json(response, 200, metadata());
			case "/register": {
				const registered = JSON.parse(await read(request));
				state.client = { client_id: "client-1", redirect_uris: registered.redirect_uris };
				state.log.push({
					register: {
						application_type: registered.application_type,
						client_name: registered.client_name,
						client_uri: registered.client_uri,
						logo_uri: registered.logo_uri,
						grant_types: registered.grant_types,
						token_endpoint_auth_method: registered.token_endpoint_auth_method,
					},
				});
				return json(response, 201, {
					...registered,
					client_id: "client-1",
					client_secret: null,
					client_uri: "",
					client_id_issued_at: null,
				});
			}
			case "/authorize": {
				const params = url.searchParams;
				const redirect = params.get("redirect_uri");
				if (
					params.get("client_id") !== state.client?.client_id ||
					!state.client.redirect_uris.includes(redirect) ||
					params.get("code_challenge_method") !== "S256"
				)
					return void response.writeHead(400).end("bad authorization request");
				if (options.deny !== undefined) {
					const back = new URL(redirect);
					back.searchParams.set("error", "access_denied");
					back.searchParams.set("error_description", options.deny);
					back.searchParams.set("state", params.get("state"));
					state.log.push({ authorize: "denied" });
					return void response.writeHead(302, { location: back.href }).end();
				}
				const code = `code-${state.pending.size + 1}`;
				state.pending.set(code, { challenge: params.get("code_challenge"), redirect, scope: params.get("scope") });
				state.log.push({ authorize: { scope: params.get("scope"), resource: params.get("resource") } });
				const back = new URL(redirect);
				back.searchParams.set("code", code);
				back.searchParams.set("state", params.get("state"));
				if (options.iss !== undefined) back.searchParams.set("iss", options.iss === "self" ? base : options.iss);
				return void response.writeHead(302, { location: back.href }).end();
			}
			case "/token": {
				const form = new URLSearchParams(await read(request));
				await options.beforeToken?.();
				const grant = form.get("grant_type");
				if (grant === "authorization_code") {
					const pending = state.pending.get(form.get("code"));
					state.pending.delete(form.get("code"));
					const verified =
						pending !== undefined &&
						createHash("sha256")
							.update(form.get("code_verifier") ?? "")
							.digest("base64url") === pending.challenge &&
						form.get("redirect_uri") === pending.redirect;
					state.log.push({ token: grant, verified });
					if (!verified || options.rejectCode)
						return json(response, 400, { error: "invalid_grant", error_description: "code rejected" });
					return json(response, 200, issue(pending.scope));
				}
				if (grant === "refresh_token") {
					const valid = form.get("refresh_token") === state.refresh && state.refresh !== undefined;
					state.log.push({ token: grant, presented: form.get("refresh_token"), valid });
					if (!valid)
						return json(response, 400, { error: "invalid_grant", error_description: "refresh token revoked" });
					state.access.clear();
					return json(response, 200, issue(state.refreshScope));
				}
				return json(response, 400, { error: "unsupported_grant_type" });
			}
			default:
				return void response.writeHead(404).end();
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${server.address().port}`;
	return {
		url: base,
		state,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
};
