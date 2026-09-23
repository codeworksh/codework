import { ModelCatalog } from "@codeworksh/harness/effect";
import { Effect } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { reportFailure } from "../../../error.ts";
import { writeError, writeOut } from "../../../output.ts";
import { Cmd } from "../../cmd.ts";
import { home } from "./catalog.ts";

export default Runtime.handler(
	Cmd.commands.models.commands.refresh,
	Effect.fn("CLI.models.refresh")(function* ({ force }) {
		const program = Effect.gen(function* () {
			const status = yield* ModelCatalog.refresh(yield* home, { force });
			yield* writeError(
				status.refreshed
					? `Refreshed model catalog at ${status.path}\n`
					: `Model catalog at ${status.path} is fresh; pass --force to download it anyway\n`,
			);
			yield* writeOut(`${status.path}\n`);
		});

		return yield* program.pipe(Effect.catch(reportFailure));
	}),
);
