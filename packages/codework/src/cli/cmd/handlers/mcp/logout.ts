import { McpOAuth } from "@codeworksh/harness/effect";
import { Effect } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { reportFailure } from "../../../error.ts";
import { writeOut } from "../../../output.ts";
import { Cmd } from "../../cmd.ts";
import { oauthServer } from "./shared.ts";

export default Runtime.handler(
	Cmd.commands.mcp.commands.logout,
	Effect.fn("CLI.mcp.logout")(function* ({ name }) {
		const program = Effect.gen(function* () {
			const { store, server } = yield* oauthServer(name);
			const removed = yield* McpOAuth.signOut(store, server);
			yield* writeOut(
				removed ? `Signed out of MCP server "${name}".\n` : `MCP server "${name}" has no stored sign-in.\n`,
			);
		});
		return yield* program.pipe(Effect.catch(reportFailure));
	}),
);
