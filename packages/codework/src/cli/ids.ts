import { Session } from "@codeworksh/harness/effect";
import { Effect, Option, Schema } from "effect";
import { InvalidInputError } from "./error.ts";

const isSessionId = Schema.is(Session.SessionSchema.ID);
const isThreadId = Schema.is(Session.ThreadSchema.ID);

/** A session ID as a person typed it; checked here because the schema's `make` throws. */
export const sessionId = Effect.fn("CLI.sessionId")(function* (value: string) {
	if (!isSessionId(value)) return yield* new InvalidInputError({ message: `${value} is not a session ID (ses_…)` });
	return value;
});

/** A `--thread` value; `main`, like no flag at all, is the session's main thread and reads as absent. */
export const threadFlag = Effect.fn("CLI.threadFlag")(function* (flag: Option.Option<string>) {
	if (Option.isNone(flag) || flag.value === Session.ThreadSchema.MAIN) return undefined;
	if (!isThreadId(flag.value)) {
		return yield* new InvalidInputError({ message: "--thread takes a thread ID (thr_…) or main" });
	}
	return flag.value;
});
