import { Global, type Mcp, McpConfig, McpOAuth, Settings } from "@codeworksh/harness/effect";
import { Effect, Option, Path, Predicate } from "effect";
import { InvalidInputError } from "../../../error.ts";
import { Jsonc } from "../../../jsonc.ts";
import { Cmd } from "../../cmd.ts";

/**
 * Where this directory's `mcp.json` files are: the user one in the home, or the `--user-config-dir`
 * that replaces it, and the project's under the nearest `.codework`, or this directory's when there
 * is none. Then what they configure.
 */
export const configured = Effect.fn("CLI.mcp.configured")(function* () {
	const shared = yield* Cmd.spec;
	const path = yield* Path.Path;
	const hostCwd = path.resolve(".");
	const paths = yield* Global.resolve(Option.isNone(shared.home) ? {} : { home: shared.home.value });
	const root = yield* Settings.projectRoot(hostCwd, paths.home);
	const userDir = Option.isNone(shared.userConfigDir)
		? paths.home
		: Settings.userConfigDir(shared.userConfigDir.value, hostCwd);
	const loaded = yield* McpConfig.load({ userDir, root });
	return {
		home: paths.home,
		authFile: Global.authFile(Option.isNone(shared.home) ? undefined : paths.home),
		hostCwd,
		root,
		user: path.join(userDir, "mcp.json"),
		project: path.join(root ?? hostCwd, Global.appConfigDir, "mcp.json"),
		...loaded,
	};
});

export const MARKS: Record<Mcp.State, string> = {
	connected: "✓",
	authenticate: "⚠",
	failed: "✗",
	connecting: "○",
	disconnected: "○",
	disabled: "○",
};

/** A server's state as the commands print it. */
export const describe = (state: Mcp.State, tools: number) =>
	state === "connected" ? `connected, ${tools} tool${tools === 1 ? "" : "s"}` : state;

/** The `mcpServers` of one `mcp.json`, and the text an edit rewrites. */
export const readServers = Effect.fn("CLI.mcp.readServers")(function* (path: string) {
	const { source, document } = yield* Jsonc.read(path, "mcp.json");
	const servers = document.mcpServers ?? {};
	if (!Predicate.isObject(servers) || Array.isArray(servers))
		return yield* new InvalidInputError({ message: `${path}: expected an object with an "mcpServers" object` });
	return { source, servers: servers as Record<string, unknown> };
});

/**
 * The OAuth server `name` names in the `mcp.json` this directory reads, the user file and the
 * project's, and the credential store of the home. A server that sends a credential of its own
 * never signs in.
 */
export const oauthServer = Effect.fn("CLI.mcp.oauthServer")(function* (name: string) {
	const { home, servers, errors } = yield* configured();
	const entry = servers.find((server) => server.name === name);
	if (entry === undefined) {
		const problems = errors.length === 0 ? "" : `\n${errors.join("\n")}`;
		return yield* new InvalidInputError({ message: `no MCP server named "${name}" in mcp.json${problems}` });
	}
	const config = entry.config;
	if (!("url" in config))
		return yield* new InvalidInputError({
			message: `MCP server "${name}" runs over stdio; only HTTP servers sign in`,
		});
	if (config.auth !== undefined)
		return yield* new InvalidInputError({
			message: `MCP server "${name}" sends the credential of provider "${config.auth.provider}"; sign in to the provider with codework auth login`,
		});
	if (Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === "authorization"))
		return yield* new InvalidInputError({
			message: `MCP server "${name}" sends its own Authorization header; remove it to sign in with OAuth`,
		});
	return {
		store: McpOAuth.store(home),
		server: { name, url: config.url, oauth: config.oauth },
		config,
	};
});
