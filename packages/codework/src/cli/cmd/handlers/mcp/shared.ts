import { Global, McpConfig, McpOAuth, Settings } from "@codeworksh/harness/effect";
import { Effect, Option, Path } from "effect";
import { InvalidInputError } from "../../../error.ts";
import { Cmd } from "../../cmd.ts";

/**
 * The OAuth server `name` names in the `mcp.json` this directory reads, the user file and the
 * project's, and the credential store of the home. A server that sends a credential of its own
 * never signs in.
 */
export const oauthServer = Effect.fn("CLI.mcp.oauthServer")(function* (name: string) {
	const shared = yield* Cmd.spec;
	const path = yield* Path.Path;
	const hostCwd = path.resolve(".");
	const paths = yield* Global.resolve(Option.isNone(shared.home) ? {} : { home: shared.home.value });
	const root = yield* Settings.projectRoot(hostCwd, paths.home);
	const userDir = Option.isNone(shared.userConfigDir)
		? paths.home
		: Settings.userConfigDir(shared.userConfigDir.value, hostCwd);
	const { servers, errors } = yield* McpConfig.load({ userDir, root });
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
		store: McpOAuth.store(paths.home),
		server: { name, url: config.url, oauth: config.oauth },
		config,
	};
});
