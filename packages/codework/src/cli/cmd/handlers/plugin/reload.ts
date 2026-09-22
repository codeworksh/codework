import { Effect } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { reportFailure } from "../../../error.ts";
import { writeOut } from "../../../output.ts";
import { Client } from "../../../../server/client.ts";
import { Cmd } from "../../cmd.ts";

/**
 * Re-import every configured plugin in a running server.
 *
 * It exists for exactly one case: a **local** plugin edited in place. Nothing in settings changed
 * and no generation moved -- a local source is never copied into the store, so it has none -- and
 * the module registry holds the old module against an unchanged URL. Everything else the runtime
 * notices for itself at the next exchange.
 *
 * There is no local form, and that is not an omission. In a CLI every run is a fresh process, so
 * the load pass happens at startup and a reload would have nothing to do.
 */
export default Runtime.handler(
	Cmd.commands.plugin.commands.reload,
	Effect.fn("CLI.plugin.reload")(function* ({ server }) {
		const program = Effect.gen(function* () {
			const rpc = yield* Client.make;
			const result = yield* rpc["plugin.reload"]({});
			// A reload that failed still reports the set that stayed loaded: the server kept
			// working, which is the whole point of not failing it.
			yield* writeOut(
				result.failure === undefined
					? `Reloaded ${result.plugins} plugin${result.plugins === 1 ? "" : "s"}.\n`
					: `Reload failed, keeping ${result.plugins} loaded: ${result.failure}\n`,
			);
			if (result.failure !== undefined) process.exitCode = 1;
		});

		return yield* program.pipe(Effect.provide(Client.layer(server)), Effect.scoped, Effect.catch(reportFailure));
	}),
);
