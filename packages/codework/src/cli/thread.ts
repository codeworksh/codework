import { Session } from "@codeworksh/harness/effect";
import { Effect, Option, Schema } from "effect";
import { InvalidInputError } from "./error.ts";

const isThreadId = Schema.is(Session.ThreadSchema.ID);

/** A `--thread` value; `main`, like no flag at all, is the session's main thread and reads as absent. */
export const threadFlag = Effect.fn("CLI.threadFlag")(function* (flag: Option.Option<string>) {
	if (Option.isNone(flag) || flag.value === Session.ThreadSchema.MAIN) return undefined;
	if (!isThreadId(flag.value)) {
		return yield* new InvalidInputError({ message: "--thread takes a thread ID (thr_…) or main" });
	}
	return Session.ThreadSchema.ID.make(flag.value);
});
