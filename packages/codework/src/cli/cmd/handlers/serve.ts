import { Effect, Layer } from "effect";
import { Runtime } from "../../../framework/runtime.ts";
import { Server } from "../../../server/server.ts";
import { renderError } from "../../error.ts";
import { harnessOptions } from "../../harness.ts";
import { writeError } from "../../output.ts";
import { Cmd } from "../cmd.ts";

export default Runtime.handler(
	Cmd.commands.serve,
	Effect.fn("CLI.serve")(function* ({ host, port }) {
		const shared = yield* Cmd.spec;
		yield* Layer.launch(Server.layer({ host, port, harness: harnessOptions(shared) })).pipe(
			Effect.catch((error) =>
				writeError(renderError(error)).pipe(
					Effect.andThen(
						Effect.sync(() => {
							process.exitCode = 1;
						}),
					),
				),
			),
		);
	}),
);
