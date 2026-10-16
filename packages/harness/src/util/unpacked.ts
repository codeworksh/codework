import { type Cause, Config, Effect, Option } from "effect";
import { importModule, resolveModule } from "./module.ts";

/**
 * Import a package that reads files from beside its own modules (WASM, workers, native addons),
 * so cannot be bundled. The standalone binary unpacks such packages into
 * `CODEWORK_PACKAGES/node_modules`; anywhere else they resolve from here as usual.
 */
export const load = (name: string): Effect.Effect<unknown, Cause.UnknownError> =>
	Effect.gen(function* () {
		const directory = yield* Config.option(Config.String("CODEWORK_PACKAGES")).pipe(Effect.orDie);
		const url = Option.isNone(directory)
			? import.meta.resolve(name)
			: yield* Effect.try(() => resolveModule(name, directory.value));
		// The binary's own `import()` reaches only built-ins.
		return yield* Effect.tryPromise(() => importModule(url));
	});
