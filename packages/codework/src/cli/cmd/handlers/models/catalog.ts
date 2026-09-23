import { Global, ModelCatalog } from "@codeworksh/harness/effect";
import { Effect, Option } from "effect";
import { Cmd } from "../../cmd.ts";

/** The home `--home` names, or the default one. */
export const home = Effect.gen(function* () {
	const shared = yield* Cmd.spec;
	return (yield* Global.resolve(Option.isNone(shared.home) ? {} : { home: shared.home.value })).home;
});

/** Check the home's catalog, as `run` does at boot, before reading it. */
export const synced = Effect.gen(function* () {
	yield* ModelCatalog.sync(yield* home);
});
