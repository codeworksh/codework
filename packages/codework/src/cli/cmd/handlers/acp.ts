import { Effect } from "effect";
import { Server } from "../../../acp/server.ts";
import { Runtime } from "../../../framework/runtime.ts";
import { reportFailure } from "../../error.ts";
import { harnessOptions } from "../../harness.ts";
import { Cmd } from "../cmd.ts";

export default Runtime.handler(
	Cmd.commands.acp,
	Effect.fn("CLI.acp")(function* () {
		const shared = yield* Cmd.spec;
		return yield* Server.serve(harnessOptions(shared)).pipe(Effect.catch(reportFailure));
	}),
);
