import { generateModels } from "@codeworksh/aikit/modelgen";
import { Effect, FileSystem, Option, Path } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { ModelgenError, reportFailure } from "../../../error.ts";
import { writeError, writeOut } from "../../../output.ts";
import { Cmd } from "../../cmd.ts";

const DEFAULT_FILENAME = "models.gen.json";

const resolveTarget = Effect.fn("CLI.models.resolveTarget")(function* (inputPath: Option.Option<string>) {
	if (Option.isNone(inputPath)) return Option.none<string>();

	const path = yield* Path.Path;
	const fs = yield* FileSystem.FileSystem;
	const raw = inputPath.value.trim();
	const asDirectory = raw === "." || raw === ".." || raw.endsWith("/") || raw.endsWith("\\");
	const resolved = path.resolve(raw);
	if (asDirectory) return Option.some(path.join(resolved, DEFAULT_FILENAME));

	const directory = yield* fs.stat(resolved).pipe(
		Effect.map((stat) => stat.type === "Directory"),
		Effect.orElseSucceed(() => false),
	);
	return Option.some(directory ? path.join(resolved, DEFAULT_FILENAME) : resolved);
});

export default Runtime.handler(
	Cmd.commands.models.commands.generate,
	Effect.fn("CLI.models.generate")(function* ({ path }) {
		const program = Effect.gen(function* () {
			const targetPath = yield* resolveTarget(path);
			const generated = yield* Effect.tryPromise({
				try: () =>
					generateModels(Option.match(targetPath, { onNone: () => ({}), onSome: (value) => ({ path: value }) })),
				catch: (cause) => new ModelgenError({ cause }),
			});
			yield* writeError(`Generated model catalog at ${generated}\n`);
			yield* writeOut(`${generated}\n`);
		});

		return yield* program.pipe(Effect.catch(reportFailure));
	}),
);
