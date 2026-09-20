import { Session } from "@codeworksh/harness/effect";
import { Effect, Option, Path } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { reportFailure } from "../../../error.ts";
import { writeOut } from "../../../output.ts";
import { Client } from "../../../../server/client.ts";
import { Cmd } from "../../cmd.ts";

/**
 * Sets `hostDir` on an existing session.
 *
 * **The session ID identifies it; the path is the target.** A project cannot identify a session --
 * it may have many or none, and it is the session that carries the field.
 *
 * The path defaults to the shell's directory, which is both the common case (you are standing in
 * the project you want to link) and safe to default: the CLI runs on the host, so the trust
 * question about naming host paths is about remote clients, not about a local shell's own cwd.
 *
 * Not `session relink`, which moves a session to another checkout of the same project. Different
 * axes -- `relink` changes where the *work* happens, `link` changes where *settings* are
 * discovered -- and conflating them would recreate the confusion the two names exist to avoid.
 */
export default Runtime.handler(
	Cmd.commands.session.commands.link,
	Effect.fn("CLI.session.link")(function* ({ session, path, unlink, server }) {
		const program = Effect.gen(function* () {
			const nodePath = yield* Path.Path;
			const rpc = yield* Client.make;
			const sessionId = Session.SessionSchema.ID.make(session);
			const hostDir = unlink
				? undefined
				: Session.AbsolutePath.make(nodePath.resolve(Option.getOrElse(path, () => ".")));

			const info = yield* rpc["session.link"]({
				sessionId,
				...(hostDir === undefined ? {} : { hostDir }),
			});
			// Settings are re-read every exchange, so this applies at the next one: no reload, no
			// restart, the project layer simply starts or stops being read.
			yield* writeOut(
				info.hostDir === undefined
					? `Unlinked ${info.id}; it now reads the user settings alone.\n`
					: `Linked ${info.id} to ${info.hostDir}\n`,
			);
		});

		return yield* program.pipe(Effect.provide(Client.layer(server)), Effect.scoped, Effect.catch(reportFailure));
	}),
);
