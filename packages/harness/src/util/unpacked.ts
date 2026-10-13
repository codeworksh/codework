import { Config, Effect, Option } from "effect";
import { resolveModule } from "./module.ts";

/**
 * What to import for a package that reads files from beside its own modules (WASM, workers,
 * native addons), so cannot be bundled. The standalone binary unpacks such packages into
 * `CODEWORK_PACKAGES/node_modules`; anywhere else they resolve by name as usual.
 */
export const specifier = (name: string): Effect.Effect<string> =>
	Effect.gen(function* () {
		const directory = yield* Config.option(Config.String("CODEWORK_PACKAGES"));
		if (Option.isNone(directory)) return name;
		return yield* Effect.try(() => resolveModule(name, directory.value));
	}).pipe(Effect.orDie);
