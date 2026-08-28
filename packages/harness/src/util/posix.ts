import { Effect, Path } from "effect";

/** Shared POSIX path implementation for sandbox and remote-runtime paths. */
export const posix = Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)));
