import { Effect, FileSystem, Path } from "effect";
import { uuidv7 } from "uuidv7";

/**
 * Writes `text` to `path` for this user alone (0600): beside it first, then renamed over it, so a
 * reader never sees half a file.
 */
export const write = Effect.fn("Private.write")(function* (path: string, text: string) {
	const fs = yield* FileSystem.FileSystem;
	yield* fs.makeDirectory((yield* Path.Path).dirname(path), { recursive: true });
	const temp = `${path}.${uuidv7()}.tmp`;
	yield* fs.writeFileString(temp, text, { mode: 0o600 });
	yield* fs.rename(temp, path);
});
