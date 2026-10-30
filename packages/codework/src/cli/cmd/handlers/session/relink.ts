import { Sandbox, Session } from "@codeworksh/harness/effect";
import { Effect, Option } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { Client } from "../../../../server/client.ts";
import { ThreadInfo } from "../../../../server/contract.ts";
import { reportFailure } from "../../../error.ts";
import { writeJson, writeOut } from "../../../output.ts";
import { threadFlag } from "../../../thread.ts";
import { Cmd } from "../../cmd.ts";

export default Runtime.handler(
	Cmd.commands.session.commands.relink,
	Effect.fn("CLI.session.relink")(function* ({ session, thread, directory, sandboxId, json, server }) {
		const program = Effect.gen(function* () {
			const threadId = yield* threadFlag(thread);
			const rpc = yield* Client.make;
			const info = yield* rpc["session.relink"]({
				sessionId: Session.SessionSchema.ID.make(session),
				...(threadId === undefined ? {} : { threadId }),
				...(Option.isNone(sandboxId) ? {} : { sandbox: { id: Sandbox.SandboxInstance.ID.make(sandboxId.value) } }),
				...(Option.isNone(directory) ? {} : { directory: directory.value }),
			});
			if (json) return yield* writeJson(ThreadInfo, info);
			// Without `--thread` the session's default moved; a thread with its own placement stays put.
			yield* writeOut(
				threadId === undefined
					? `Moved ${info.session.id} to ${info.session.directory}\n`
					: `Moved thread ${info.id} of ${info.session.id} to ${info.placement?.directory ?? info.session.directory}\n`,
			);
		});

		return yield* program.pipe(Effect.provide(Client.layer(server)), Effect.scoped, Effect.catch(reportFailure));
	}),
);
