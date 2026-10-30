import { Schema } from "effect";

// Thread identity lives in `@codeworksh/plugin`, next to the session's: it is on every plugin
// context and every tool call.
import type { ThreadID } from "@codeworksh/plugin/ids";
export { ThreadID as ID } from "@codeworksh/plugin/ids";

export const IDFromDb = Schema.String.pipe(Schema.brand("Thread.ID"));

/** How a thread came to exist; stored flattened as the `origin_*` columns. */
export const OriginKind = Schema.Literals(["main", "fork", "subagent"]);
export type OriginKind = typeof OriginKind.Type;

export type Origin =
	/** The session's default thread. Exactly one per session. */
	| { readonly kind: "main" }
	/** History continues from `threadId` through `entryId`. */
	| { readonly kind: "fork"; readonly threadId: ThreadID; readonly entryId: string }
	/**
	 * Spawned by tool call `callId` in `threadId`, which waits on it. `entryId` set = inherits that
	 * thread's history through it; absent = starts empty.
	 */
	| { readonly kind: "subagent"; readonly threadId: ThreadID; readonly callId: string; readonly entryId?: string };

/**
 * A run left unfinished: `running` while one is in flight, and still after the process died during
 * it; `closed` once a shutdown stopped it. Either resumes when the server starts again; a run that
 * ended any other way leaves none.
 */
export const Execution = Schema.Literals(["running", "closed"]);
export type Execution = typeof Execution.Type;

/** `main` names a session's main thread wherever a thread id is accepted from a person. */
export const MAIN = "main";

export const TITLE_MAX_LENGTH = 48;

/**
 * A title from a prompt: its first non-empty line, whitespace collapsed, cut on a word boundary
 * to {@link TITLE_MAX_LENGTH} characters including the ellipsis. `undefined` for a blank prompt.
 */
export const titleFrom = (text: string): string | undefined => {
	const line = text
		.split("\n")
		.map((one) => one.replace(/\s+/g, " ").trim())
		.find((one) => one.length > 0);
	if (line === undefined || line.length <= TITLE_MAX_LENGTH) return line;
	const cut = line.slice(0, TITLE_MAX_LENGTH - 1);
	const space = cut.lastIndexOf(" ");
	return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

export * as ThreadSchema from "./schema.ts";
