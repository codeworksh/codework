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
 * - `hidden`: never registered.
 */
export type Exposure = "direct" | "hidden";

/**
 * Who shares one running instance of a server.
 *
 * - `session`: each session runs its own.
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

/** A Streamable HTTP server. `headers` values resolve like a stdio server's `env`. */
export interface HttpServer extends Base {
	readonly type?: "http" | "streamable-http";
	readonly url: string;
	readonly headers?: Readonly<Record<string, string>>;
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
