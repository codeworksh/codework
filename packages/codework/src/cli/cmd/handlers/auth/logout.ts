import { oauthNotice } from "@codeworksh/aikit/oauth/summary";
import { Effect, Option } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { reportFailure } from "../../../error.ts";
import { writeError } from "../../../output.ts";
import { Cmd } from "../../cmd.ts";
import {
	assertServerScope,
	attempt,
	Client,
	localOps,
	oauthProviderLabel,
	selectProvider,
	withServer,
} from "./shared.ts";

export default Runtime.handler(
	Cmd.commands.auth.commands.logout,
	Effect.fn("CLI.auth.logout")(function* ({ server, openaiCodex, githubCopilot, authFile }) {
		const program = Effect.gen(function* () {
			const provider = yield* selectProvider({ openaiCodex, githubCopilot });
			const name = oauthProviderLabel(provider);

			if (Option.isSome(server)) {
				yield* assertServerScope(authFile);
				return yield* withServer(
					server.value,
					Effect.gen(function* () {
						const rpc = yield* Client.make;
						yield* rpc["auth.logout"]({ provider });
						yield* writeError(`${oauthNotice("cleared", provider, "the server")}\n`);
					}),
				);
			}

			const ops = yield* localOps(provider, authFile);
			yield* attempt(`failed to clear ${name} credentials`, () => ops.logout());
			yield* writeError(`${oauthNotice("cleared", provider, ops.path)}\n`);
		});

		return yield* program.pipe(Effect.catch(reportFailure));
	}),
);
