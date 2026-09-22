/* @effect-diagnostics nodeBuiltinImport:off -- OAuth login opens the system browser. */
/* @effect-diagnostics globalDate:off -- Stored expiry timestamps are rendered for the user. */
/* oxlint-disable effecttsgo/async-function -- Aikit OAuth callbacks require Promise-returning functions. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
	JsonOpenAICodexAuthStorage,
	OpenAICodexOAuthClient,
	openAICodexHeaders,
	type OpenAICodexAuthStorage,
	type OpenAICodexOAuthCredentials,
} from "@codeworksh/aikit/oauth/openai/codex";
import { Global } from "@codeworksh/harness/effect";
import { Effect, Option, Path } from "effect";
import { Runtime } from "../../../framework/runtime.ts";
import { Client } from "../../../server/client.ts";
import { InvalidInputError, OAuthError, reportFailure } from "../../error.ts";
import { writeError, writeOut } from "../../output.ts";
import { Cmd } from "../cmd.ts";

const promptLine = async (message: string): Promise<string> => {
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return await readline.question(`${message} `);
	} finally {
		readline.close();
	}
};

const openBrowser = (url: string): void => {
	const command =
		process.platform === "darwin"
			? { file: "open", args: [url] }
			: process.platform === "win32"
				? { file: "cmd", args: ["/c", "start", "", url] }
				: { file: "xdg-open", args: [url] };
	const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" });
	child.unref();
};

const formatInfo = (
	credentials: {
		readonly accountId: string;
		readonly expires: number;
	},
	json: boolean,
): string => {
	if (json) {
		return `${JSON.stringify(
			{
				...credentials,
				expiresAt: new Date(credentials.expires).toISOString(),
			},
			null,
			2,
		)}\n`;
	}
	return [`Account: ${credentials.accountId}`, `Expires: ${new Date(credentials.expires).toLocaleString()}`, ""].join(
		"\n",
	);
};

const login = (
	client: OpenAICodexOAuthClient,
	options: { readonly originator: string; readonly manual: boolean; readonly browser: boolean },
): Promise<OpenAICodexOAuthCredentials> =>
	client.login({
		originator: options.originator,
		...(options.manual && {
			onManualCodeInput: () =>
				promptLine("Paste the redirect URL or authorization code, or wait for browser callback:"),
		}),
		onAuth: (info) => {
			process.stdout.write(
				`${info.instructions ?? "Complete OpenAI Codex authentication in your browser."}\n${info.url}\n`,
			);
			if (!options.browser) return;
			try {
				openBrowser(info.url);
			} catch (error) {
				process.stderr.write(`Failed to open browser: ${error instanceof Error ? error.message : String(error)}\n`);
			}
		},
		onPrompt: (prompt) => promptLine(prompt.message),
	});

const formatCredentials = (
	credentials: OpenAICodexOAuthCredentials,
	options: { readonly json: boolean; readonly printHeaders: boolean },
): string => {
	if (options.json) {
		return `${JSON.stringify(
			{
				accountId: credentials.accountId,
				expires: credentials.expires,
				expiresAt: new Date(credentials.expires).toISOString(),
				...(options.printHeaders ? { headers: openAICodexHeaders(credentials) } : {}),
			},
			null,
			2,
		)}\n`;
	}

	const headers = options.printHeaders
		? `Headers:\n${Object.entries(openAICodexHeaders(credentials))
				.map(([name, value]) => `${name}: ${value}`)
				.join("\n")}\n`
		: "";
	return `Account: ${credentials.accountId}\nExpires: ${new Date(credentials.expires).toLocaleString()}\n${headers}`;
};

export default Runtime.handler(
	Cmd.commands.auth,
	Effect.fn("CLI.auth")(function* ({
		server,
		openaiCodex,
		authFile,
		browser,
		manual,
		originator,
		status,
		refresh,
		logout,
		json,
		printHeaders,
	}) {
		const program = Effect.gen(function* () {
			if (!openaiCodex) {
				return yield* new InvalidInputError({
					message: "choose an auth provider, for example: auth --openai-codex",
				});
			}
			if ([status, refresh, logout].filter(Boolean).length > 1) {
				return yield* new InvalidInputError({ message: "choose only one of --status, --refresh, or --logout" });
			}

			const shared = yield* Cmd.spec;
			if (Option.isSome(server)) {
				if (Option.isSome(authFile) || Option.isSome(shared.home)) {
					return yield* new InvalidInputError({
						message: "--auth-file and --home belong on codework serve when using --server",
					});
				}
				if (printHeaders) {
					return yield* new InvalidInputError({
						message: "--print-headers is unavailable through an RPC server",
					});
				}

				const remote = Effect.gen(function* () {
					const rpc = yield* Client.make;
					if (logout) {
						yield* rpc["openaiCodex.auth.logout"]({});
						yield* writeOut("Cleared OpenAI Codex credentials on the server\n");
						return;
					}
					if (status || refresh) {
						const credentialsEffect = refresh
							? rpc["openaiCodex.auth.refresh"]({})
							: rpc["openaiCodex.auth.status"]({});
						const credentials = yield* credentialsEffect;
						if (credentials === null) {
							return yield* new OAuthError({ message: "no OpenAI Codex credentials found on the server" });
						}
						if (refresh) yield* writeError("Refreshed OpenAI Codex credentials on the server\n");
						yield* writeOut(formatInfo(credentials, json));
						return;
					}

					const transientStorage: OpenAICodexAuthStorage = {
						get: () => Promise.resolve(undefined),
						set: () => Promise.resolve(),
						clear: () => Promise.resolve(),
					};
					const credentials = yield* Effect.tryPromise({
						try: () =>
							login(new OpenAICodexOAuthClient({ storage: transientStorage }), {
								originator,
								manual,
								browser,
							}),
						catch: (cause) => new OAuthError({ message: "OpenAI Codex login failed", cause }),
					});
					const saved = yield* rpc["openaiCodex.auth.save"]({ credentials });
					yield* writeError("Saved OpenAI Codex credentials on the server\n");
					yield* writeOut(formatInfo(saved, json));
				});

				return yield* remote.pipe(Effect.provide(Client.layer(server.value)), Effect.scoped);
			}

			const path = yield* Path.Path;
			const configuredPath = Option.isSome(authFile)
				? authFile.value
				: Option.isSome(shared.home)
					? path.join((yield* Global.resolve({ home: shared.home.value })).home, "aikit", "auth.json")
					: undefined;
			const storage = new JsonOpenAICodexAuthStorage(configuredPath === undefined ? {} : { path: configuredPath });
			const client = new OpenAICodexOAuthClient({ storage });

			if (logout) {
				yield* Effect.tryPromise({
					try: () => client.logout(),
					catch: (cause) => new OAuthError({ message: "failed to clear OpenAI Codex credentials", cause }),
				});
				yield* writeOut(`Cleared OpenAI Codex credentials from ${storage.path}\n`);
				return;
			}

			if (status) {
				const credentials = yield* Effect.tryPromise({
					try: () => storage.get(),
					catch: (cause) => new OAuthError({ message: "failed to read OpenAI Codex credentials", cause }),
				});
				if (credentials === undefined) {
					return yield* new OAuthError({ message: `no OpenAI Codex credentials found at ${storage.path}` });
				}
				yield* writeOut(formatCredentials(credentials, { json, printHeaders }));
				return;
			}

			if (refresh) {
				const credentials = yield* Effect.tryPromise({
					try: () => client.getCredentials(),
					catch: (cause) => new OAuthError({ message: "failed to refresh OpenAI Codex credentials", cause }),
				});
				if (credentials === undefined) {
					return yield* new OAuthError({ message: `no OpenAI Codex credentials found at ${storage.path}` });
				}
				yield* writeError(`Refreshed OpenAI Codex credentials in ${storage.path}\n`);
				yield* writeOut(formatCredentials(credentials, { json, printHeaders }));
				return;
			}

			const credentials = yield* Effect.tryPromise({
				try: () => login(client, { originator, manual, browser }),
				catch: (cause) => new OAuthError({ message: "OpenAI Codex login failed", cause }),
			});

			yield* writeError(`Saved OpenAI Codex credentials to ${storage.path}\n`);
			yield* writeOut(formatCredentials(credentials, { json, printHeaders }));
		});

		return yield* program.pipe(Effect.catch(reportFailure));
	}),
);
