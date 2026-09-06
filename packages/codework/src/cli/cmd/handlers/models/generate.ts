import { generateModels } from "@codeworksh/aikit/modelgen";
import { Effect, FileSystem, Option, Path } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { ModelgenError } from "../../../error.ts";
import { writeOut } from "../../../output.ts";
import { Cmd } from "../../cmd.ts";

const DEFAULT_FILENAME = "models.gen.json";

const resolveTarget = Effect.fn("CLI.models.resolveTarget")(function* (inputPath: Option.Option<string>) {
	const path = yield* Path.Path;
	const fs = yield* FileSystem.FileSystem;

	const isDir = (candidate: string) =>
		candidate.endsWith("/") || candidate.endsWith("\\") || candidate === "." || candidate === ".."
			? Effect.succeed(true)
			: fs.stat(candidate).pipe(
					Effect.map((stat) => stat.type === "Directory"),
					Effect.orElseSucceed(() => false),
				);

	if (Option.isSome(inputPath)) {
		const raw = inputPath.value.trim();
		const resolved = path.resolve(raw);
		const directory = yield* isDir(resolved);
		return directory ? path.join(resolved, DEFAULT_FILENAME) : resolved;
	}

	const envFile = process.env.CODEWORK_MODELS_FILE?.trim();
	if (envFile) {
		const resolved = path.resolve(envFile);
		const directory = yield* isDir(resolved);
		return directory ? path.join(resolved, DEFAULT_FILENAME) : resolved;
	}

	return path.resolve(DEFAULT_FILENAME);
});

export default Runtime.handler(
	Cmd.commands.models.commands.generate,
	Effect.fn("CLI.models.generate")(function* ({ path }) {
		const targetPath = yield* resolveTarget(path);
		const generated = yield* Effect.tryPromise({
			try: () => generateModels({ path: targetPath }),
			catch: (cause) => new ModelgenError({ cause }),
		});
		yield* writeOut(`Generated model catalog at ${generated}\n`);
	}),
);
