import { formatOAuthSummary, oauthNotice, oauthRefreshIssue } from "@codeworksh/aikit/oauth/summary";
import { Effect, Option } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { InvalidInputError, OAuthError, reportFailure } from "../../../error.ts";
import { writeError, writeOut } from "../../../output.ts";
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
	Cmd.commands.auth.commands.refresh,
	Effect.fn("CLI.auth.refresh")(function* ({ server, openaiCodex, githubCopilot, authFile, json }) {
		const program = Effect.gen(function* () {
			const provider = yield* selectProvider({ openaiCodex, githubCopilot });
			const blocked = oauthRefreshIssue(provider);
			if (blocked !== undefined) return yield* new InvalidInputError({ message: blocked });

			const name = oauthProviderLabel(provider);

			if (Option.isSome(server)) {
				yield* assertServerScope(authFile);
				return yield* withServer(
					server.value,
					Effect.gen(function* () {
						const rpc = yield* Client.make;
						const info = yield* rpc["auth.refresh"]({ provider });
						if (info === null) {
							return yield* new OAuthError({ message: oauthNotice("missing", provider, "the server") });
						}
						yield* writeError(`${oauthNotice("refreshed", provider, "the server")}\n`);
						yield* writeOut(formatOAuthSummary(info, { json }));
					}),
				);
			}

			const ops = yield* localOps(provider, authFile);
			const summary = yield* attempt(`failed to read ${name} credentials`, () => ops.refreshed());
			if (summary === undefined) {
				return yield* new OAuthError({ message: oauthNotice("missing", provider, ops.path) });
			}
			yield* writeError(`${oauthNotice("refreshed", provider, ops.path)}\n`);
			yield* writeOut(formatOAuthSummary(summary, { json }));
		});

		return yield* program.pipe(Effect.catch(reportFailure));
	}),
);
