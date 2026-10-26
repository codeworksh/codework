/* @effect-diagnostics nodeBuiltinImport:off -- the pasted redirect URL is read from the terminal. */
import { createInterface } from "node:readline/promises";
import { openBrowser } from "@codeworksh/aikit/oauth/interactive";
import { McpOAuth } from "@codeworksh/harness/effect";
import { Duration, Effect, Logger } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { OAuthError, reportFailure } from "../../../error.ts";
import { writeError, writeOut } from "../../../output.ts";
import { Cmd } from "../../cmd.ts";
import { oauthServer } from "./shared.ts";

/**
 * The redirected URL, typed into the terminal when the browser cannot reach this machine's
 * callback (over SSH, say). Without a terminal there is no one to ask, and only the callback counts.
 */
const paste: Effect.Effect<string | undefined> = process.stdin.isTTY
	? Effect.acquireUseRelease(
			Effect.sync(() => createInterface({ input: process.stdin, output: process.stderr })),
			(readline) =>
				Effect.tryPromise((signal) =>
					readline.question("Or paste the URL the browser was redirected to: ", { signal }),
				).pipe(Effect.orElseSucceed(() => undefined)),
			(readline) => Effect.sync(() => readline.close()),
		)
	: Effect.never;

export default Runtime.handler(
	Cmd.commands.mcp.commands.login,
	Effect.fn("CLI.mcp.login")(function* ({ name, browser, timeout }) {
		const program = Effect.gen(function* () {
			const { store, config } = yield* oauthServer(name);
			const limit = Duration.seconds(timeout);
			const result = yield* McpOAuth.login({
				store,
				name,
				config,
				prompt: {
					show: (url) =>
						Effect.gen(function* () {
							yield* writeError(`Sign in to MCP server "${name}" in your browser:\n${url.href}\n`);
							if (browser)
								yield* Effect.sync(
									() =>
										void openBrowser(url.href, (error) =>
											process.stderr.write(`Failed to open browser: ${error.message}\n`),
										),
								);
						}),
					paste,
				},
			}).pipe(
				Effect.timeoutOrElse({
					duration: limit,
					orElse: () =>
						Effect.fail(new OAuthError({ message: `sign-in timed out after ${Duration.format(limit)}` })),
				}),
			);
			const tools = `${result.tools} tool${result.tools === 1 ? "" : "s"}`;
			yield* writeOut(
				result.signedIn
					? `Signed in to MCP server "${name}" (${tools}).\n`
					: `Already signed in to MCP server "${name}" (${tools}).\n`,
			);
		});
		// Stdout carries only the outcome; harness logs go with the rest of the diagnostics.
		return yield* program.pipe(Effect.provideService(Logger.LogToStderr, true), Effect.catch(reportFailure));
	}),
);
