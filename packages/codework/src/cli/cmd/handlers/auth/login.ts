import { formatOAuthSummary, oauthLoginIssue, oauthNotice } from "@codeworksh/aikit/oauth/summary";
import { Effect, Option } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { InvalidInputError, reportFailure } from "../../../error.ts";
import { writeError, writeOut } from "../../../output.ts";
import { Cmd } from "../../cmd.ts";
import {
	assertServerScope,
	attempt,
	Client,
	localOps,
	makeOps,
	oauthProviderLabel,
	selectProvider,
	withServer,
	type LoginOptions,
} from "./shared.ts";

export default Runtime.handler(
	Cmd.commands.auth.commands.login,
	Effect.fn("CLI.auth.login")(function* ({
		server,
		openaiCodex,
		githubCopilot,
		authFile,
		browser,
		device,
		enterprise,
		enableModels,
		json,
	}) {
		const program = Effect.gen(function* () {
			const provider = yield* selectProvider({ openaiCodex, githubCopilot });
			const issue = oauthLoginIssue(provider, {
				device,
				enableModels,
				...(Option.isSome(enterprise) && { enterprise: enterprise.value }),
			});
			if (issue !== undefined) return yield* new InvalidInputError({ message: issue });

			const name = oauthProviderLabel(provider);
			const options: LoginOptions = { browser, device, enterprise, enableModels };

			if (Option.isSome(server)) {
				yield* assertServerScope(authFile);
				return yield* withServer(
					server.value,
					Effect.gen(function* () {
						const rpc = yield* Client.make;
						// The browser callback and the device prompt both need this
						// terminal, so the login runs here and only the result travels.
						const { wire } = yield* attempt(`${name} login failed`, () =>
							makeOps(provider, { persist: false }).login(options),
						);
						const info = yield* rpc["auth.save"]({ credentials: wire });
						yield* writeError(`${oauthNotice("saved", provider, "the server")}\n`);
						yield* writeOut(formatOAuthSummary(info, { json }));
					}),
				);
			}

			const ops = yield* localOps(provider, authFile);
			const { summary } = yield* attempt(`${name} login failed`, () => ops.login(options));
			yield* writeError(`${oauthNotice("saved", provider, ops.path)}\n`);
			yield* writeOut(formatOAuthSummary(summary, { json }));
		});

		return yield* program.pipe(Effect.catch(reportFailure));
	}),
);
