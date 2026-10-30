/**
 * MCP servers a session runs, as plugins see and edit them.
 *
 * The harness seeds the bucket from `mcp.json` (the user file, then the project's), `mcp` plugins
 * edit it, and it freezes before the `tool` domain runs: the servers are settled before any tool
 * exists. Only configuration lives here. Whether a server is connected changes on its own, at any
 * moment, so it is never part of what a plugin reads during setup.
 */

/**
 * How a server's tools reach the model.
 *
 * - `direct`: declared to the model like any other tool.
 * - `codemode`: called from codemode scripts, never declared to the model.
 * - `deferred`: declared once `toolsearch` loads them.
 * - `hidden`: never offered to the model.
 *
 * Until codemode exists, `codemode` tools cannot be called. `codemode-deferred` in `mcp.json` is
 * read as `codemode`.
 */
export type Exposure = "direct" | "codemode" | "deferred" | "hidden";

/**
 * Who shares one running instance of a server.
 *
 * - `session`: threads of one session at the same place share one.
 * - `space`: sessions in the same space (sandbox and folder) share one.
 * - `app`: every session shares one.
 */
export type Scope = "session" | "space" | "app";

interface Base {
	/** Default: `direct`. */
	readonly exposure?: Exposure;
	/**
	 * Exposure of single tools, overriding `exposure`. Keys are tool names as the server offers them,
	 * or patterns where `*` matches any characters. An exact name wins over patterns; among patterns
	 * the first match wins. `"exposure": "hidden"` with a few entries here exposes only those tools.
	 */
	readonly toolExposure?: Readonly<Record<string, Exposure>>;
	/** `false` keeps the entry without connecting. Default: `true`. */
	readonly enabled?: boolean;
	/** Default: `session`. Share a server only when it is safe to share. */
	readonly scope?: Scope;
	/** Per-request timeout in seconds. Progress notifications from the server reset it. Default: 60. */
	readonly timeout?: number;
	/** What the server offers, in a sentence. */
	readonly description?: string;
}

/**
 * A server the harness starts as a process on the host. `env` values may name environment
 * variables (`${NAME}`) or be a command whose output is the value (`!command`).
 */
export interface StdioServer extends Base {
	readonly type?: "stdio";
	/** One executable, not a shell command line. */
	readonly command: string;
	readonly args?: ReadonlyArray<string>;
	readonly env?: Readonly<Record<string, string>>;
	/** Relative to the session's directory. */
	readonly cwd?: string;
}

/**
 * OAuth client settings, for servers that do not accept dynamic client registration or need a
 * fixed redirect URI.
 */
export interface OAuthConfig {
	/** A pre-registered client id. Without it, the harness registers a client with the server. */
	readonly clientId?: string;
	/** Resolves like a header value. */
	readonly clientSecret?: string;
	/** Port of the loopback callback, for a client registered with a fixed redirect URI. */
	readonly callbackPort?: number;
	/**
	 * The redirect URI registered for `clientId`: `http` on `localhost`, `127.0.0.1` or `[::1]`.
	 * Without a port, the callback listens on `callbackPort` or a free port.
	 */
	readonly callbackUrl?: string;
	/** Scopes to request, separated by spaces. Default: the scopes the server advertises. */
	readonly scope?: string;
	/** `client_name` sent with dynamic client registration. Default: `CodeWork`. */
	readonly clientName?: string;
	/**
	 * Authorization server metadata (RFC 8414 or OpenID Connect discovery) to use instead of
	 * discovering it through the server. `https`, or `http` on a loopback host.
	 */
	readonly authServerMetadataUrl?: string;
}

/**
 * A Streamable HTTP server. `headers` values resolve like a stdio server's `env`.
 *
 * A server without an `Authorization` header or `auth` signs in with OAuth when it answers 401
 * (`codework mcp login <name>`).
 */
export interface HttpServer extends Base {
	readonly type?: "http" | "streamable-http";
	readonly url: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly oauth?: OAuthConfig;
	/**
	 * Send a model provider's credential (its login token, else its API key) as the bearer instead
	 * of using OAuth. Only in the user `mcp.json`, and only to `https` URLs or loopback hosts.
	 */
	readonly auth?: { readonly provider: string };
}

export type ServerConfig = StdioServer | HttpServer;

/** The settings a plugin can change on a server without restating where it runs. */
export type ServerPatch = Pick<Base, "enabled" | "exposure" | "toolExposure" | "timeout" | "description">;

export interface McpRegistry {
	readonly list: () => ReadonlyArray<readonly [name: string, config: ServerConfig]>;
	readonly get: (name: string) => ServerConfig | undefined;
	/** Add a server or replace one. Throws on an invalid name or config. */
	readonly set: (name: string, config: ServerConfig) => void;
	/** Throws when no server has this name. */
	readonly update: (name: string, patch: ServerPatch) => void;
	readonly remove: (name: string) => void;
}
