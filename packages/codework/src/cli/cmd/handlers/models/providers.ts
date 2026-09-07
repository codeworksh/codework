import { Effect } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { reportFailure } from "../../../error.ts";
import { writeOut } from "../../../output.ts";
import { Cmd } from "../../cmd.ts";
import { loadProviders } from "./catalog.ts";

export default Runtime.handler(
	Cmd.commands.models.commands.providers,
	Effect.fn("CLI.models.providers")(function* () {
		const program = Effect.gen(function* () {
			const providers = yield* loadProviders;
			const sorted = [...providers].sort((a, b) => a.localeCompare(b));
			yield* writeOut(sorted.map((providerId) => `${providerId}\n`).join(""));
		});

		return yield* program.pipe(Effect.catch(reportFailure));
	}),
);
