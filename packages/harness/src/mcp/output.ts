/**
 * Files for MCP output the model is not shown in full: the whole text of a truncated result, and
 * binary resources. They live on the host, like MCP itself, and never in a session's sandbox.
 */

import { tmpdir } from "node:os";
import { Effect } from "effect";
import { Hex } from "effect/encoding";
import { crypto, fileSystem, hostPath } from "../host.ts";
import { OutputError } from "./error.ts";

/** Output can carry private data, so only the user may read the files. */
const MODE = 0o600;

/** Write `data` to a new file and return its path. `extension` includes the dot. */
export const save = Effect.fn("Mcp.saveOutput")(function* (data: string | Uint8Array, extension: string) {
	const random = yield* crypto.randomBytes(8).pipe(Effect.orDie);
	const path = hostPath.join(tmpdir(), `codework-mcp-${Hex.encode(random)}${extension}`);
	const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
	// `wx` never follows a link someone else placed at the path.
	yield* fileSystem
		.writeFile(path, bytes, { flag: "wx", mode: MODE })
		.pipe(Effect.mapError((error) => new OutputError({ message: error.message })));
	return path;
});

export * as McpOutput from "./output.ts";
