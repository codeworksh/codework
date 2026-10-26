import { Effect, FileSystem } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { InvalidInputError, reportFailure } from "../../../error.ts";
import { Jsonc } from "../../../jsonc.ts";
import { writeOut } from "../../../output.ts";
import { Cmd } from "../../cmd.ts";
import { configured, readServers } from "./shared.ts";

export default Runtime.handler(
	Cmd.commands.mcp.commands.remove,
	Effect.fn("CLI.mcp.remove")(function* ({ name, local }) {
		const program = Effect.gen(function* () {
			const { user, project, servers } = yield* configured();
			const path = local ? project : user;
			const level = local ? "project" : "user";
			const fs = yield* FileSystem.FileSystem;
			// No file, nothing to remove: locking it would make its directory, and a `.codework/` here.
			const removed =
				(yield* fs.exists(path)) &&
				(yield* Jsonc.locked(
					path,
					Effect.gen(function* () {
						const { source, servers } = yield* readServers(path);
						if (servers[name] === undefined) return false;
						yield* Jsonc.write(path, source, ["mcpServers", name], undefined);
						return true;
					}),
				));
			if (removed) return yield* writeOut(`Removed ${level} MCP server "${name}" from ${path}.\n`);
			const other = servers.find((server) => server.name === name && server.file !== path);
			const hint =
				other === undefined
					? ""
					: ` It is defined in ${other.file}; ${other.file === project ? "use --local" : "omit --local"}.`;
			return yield* new InvalidInputError({
				message: `no ${level} MCP server named "${name}" in ${path}.${hint}`,
			});
		});
		return yield* program.pipe(Effect.catch(reportFailure));
	}),
);
