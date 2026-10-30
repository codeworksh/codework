import { Session } from "@codeworksh/harness/effect";
import { Effect, Option, Schema } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { Client } from "../../../../server/client.ts";
import { ThreadInfo } from "../../../../server/contract.ts";
import { InvalidInputError, reportFailure } from "../../../error.ts";
import { writeJson, writeOut } from "../../../output.ts";
import { threadFlag } from "../../../thread.ts";
import { Cmd } from "../../cmd.ts";

const Forked = Schema.Struct({ thread: ThreadInfo, text: Schema.optional(Schema.String) });

export default Runtime.handler(
	Cmd.commands.thread.commands.fork,
	Effect.fn("CLI.thread.fork")(function* ({ session, thread, at, before, json, server }) {
		const program = Effect.gen(function* () {
			const point = Option.isSome(at)
				? Option.isNone(before)
					? { entryId: at.value }
					: undefined
				: Option.map(before, (entryId) => ({ entryId, mode: "before" as const })).pipe(Option.getOrUndefined);
			if (point === undefined) {
				return yield* new InvalidInputError({ message: "Pass exactly one of --at or --before" });
			}
			const threadId = yield* threadFlag(thread);
			const rpc = yield* Client.make;
			const forked = yield* rpc["thread.fork"]({
				sessionId: Session.SessionSchema.ID.make(session),
				...(threadId === undefined ? {} : { threadId }),
				...point,
			});
			if (json) return yield* writeJson(Forked, forked);
			yield* writeOut(`${forked.thread.id}\n`);
			if (forked.text !== undefined) yield* writeOut(`\n${forked.text}\n`);
		});

		return yield* program.pipe(Effect.provide(Client.layer(server)), Effect.scoped, Effect.catch(reportFailure));
	}),
);
