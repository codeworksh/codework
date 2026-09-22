import { formatOAuthSummary, oauthNotice } from "@codeworksh/aikit/oauth/summary";
import { Effect, Option } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { OAuthError, reportFailure } from "../../../error.ts";
import { writeOut } from "../../../output.ts";
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
	Cmd.commands.auth.commands.status,
	Effect.fn("CLI.auth.status")(function* ({ server, openaiCodex, githubCopilot, authFile, json }) {
		const program = Effect.gen(function* () {
			const provider = yield* selectProvider({ openaiCodex, githubCopilot });
			const name = oauthProviderLabel(provider);

			if (Option.isSome(server)) {
				yield* assertServerScope(authFile);
				return yield* withServer(
					server.value,
					Effect.gen(function* () {
						const rpc = yield* Client.make;
						const info = yield* rpc["auth.status"]({ provider });
						if (info === null) {
							return yield* new OAuthError({ message: oauthNotice("missing", provider, "the server") });
						}
						yield* writeOut(formatOAuthSummary(info, { json }));
					}),
				);
			}

			const ops = yield* localOps(provider, authFile);
			const summary = yield* attempt(`failed to read ${name} credentials`, () => ops.stored());
			if (summary === undefined) {
				return yield* new OAuthError({ message: oauthNotice("missing", provider, ops.path) });
			}
			yield* writeOut(formatOAuthSummary(summary, { json }));
		});

		return yield* program.pipe(Effect.catch(reportFailure));
	}),
);
