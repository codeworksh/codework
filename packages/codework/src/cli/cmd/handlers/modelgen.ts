import { generateModels } from "@codeworksh/aikit/modelgen";
import { Effect, Option } from "effect";
import { Runtime } from "../../../framework/runtime.ts";
import { ModelgenError } from "../../error.ts";
import { writeOut } from "../../output.ts";
import { Cmd } from "../cmd.ts";

export default Runtime.handler(
	Cmd.commands.modelgen,
	Effect.fn("CLI.modelgen")(function* ({ path }) {
		const generated = yield* Effect.tryPromise({
			try: () => generateModels(Option.isNone(path) ? {} : { path: path.value }),
			catch: (cause) => new ModelgenError({ cause }),
		});
		yield* writeOut(`Generated model catalog at ${generated}\n`);
	}),
);
