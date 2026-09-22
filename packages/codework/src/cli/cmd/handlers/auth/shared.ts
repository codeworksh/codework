/* @effect-diagnostics nodeBuiltinImport:off -- OAuth login opens the system browser. */
/* @effect-diagnostics globalDate:off -- Stored expiry timestamps are rendered for the user. */
/* oxlint-disable effecttsgo/async-function -- Aikit OAuth callbacks require Promise-returning functions. */
import {
	GitHubCopilotOAuthClient,
	JsonGitHubCopilotAuthStorage,
	type GitHubCopilotAuthStorage,
} from "@codeworksh/aikit/oauth/github/copilot";
import {
	JsonOpenAICodexAuthStorage,
	OpenAICodexOAuthClient,
	type OpenAICodexAuthStorage,
} from "@codeworksh/aikit/oauth/openai/codex";
import { openBrowser, promptLine } from "@codeworksh/aikit/oauth/interactive";
import {
	checkOAuthProvider,
	oauthProviderLabel,
	summarizeGitHubCopilot,
	summarizeOpenAICodex,
	type OAuthSummary,
} from "@codeworksh/aikit/oauth/summary";
import { Global } from "@codeworksh/harness/effect";
import { Effect, Option, Path } from "effect";
import { Client } from "../../../../server/client.ts";
import type { Contract } from "../../../../server/contract.ts";
import { InvalidInputError, OAuthError } from "../../../error.ts";
import { Cmd } from "../../cmd.ts";

export type Provider = Contract.OAuthProvider;

// The wire shape and aikit's summary are the same record.
export type Summary = Contract.OAuthInfo & OAuthSummary;

const announce = (
	info: { url: string; userCode?: string | undefined; instructions?: string | undefined },
	browser: boolean,
): void => {
	process.stderr.write(
		`${info.instructions ?? "Complete authentication in your browser."}\n${
			info.userCode === undefined ? "" : `Enter code: ${info.userCode}\n`
		}${info.url}\n`,
	);
	if (browser) {
		void openBrowser(info.url, (error) => void process.stderr.write(`Failed to open browser: ${error.message}\n`));
	}
};

export interface LoginOptions {
	readonly browser: boolean;
	readonly device: boolean;
	readonly enterprise: Option.Option<string>;
	readonly enableModels: boolean;
}

export interface Ops {
	readonly path: string;
	readonly login: (options: LoginOptions) => Promise<{ wire: Contract.OAuthCredentials; summary: Summary }>;
	readonly stored: () => Promise<Summary | undefined>;
	readonly refreshed: () => Promise<Summary | undefined>;
	readonly logout: () => Promise<void>;
}

/** Holds nothing: a server's credentials live on the server, not on this disk. */
const transient: OpenAICodexAuthStorage & GitHubCopilotAuthStorage = {
	get: async () => undefined,
	set: async () => {},
	clear: async () => {},
};

const codexOps = (storage: OpenAICodexAuthStorage, path: string): Ops => {
	const client = new OpenAICodexOAuthClient({ storage });
	return {
		path,
		login: async (options) => {
			const credentials = await client.login({
				device: options.device,
				onAuth: (info) => announce(info, options.browser),
				onProgress: (message) => void process.stderr.write(`${message}\n`),
				onPrompt: (prompt) => promptLine(prompt.message),
			});
			return { wire: { provider: "openai-codex", ...credentials }, summary: summarizeOpenAICodex(credentials) };
		},
		stored: async () => {
			const credentials = await storage.get();
			return credentials && summarizeOpenAICodex(credentials);
		},
		refreshed: async () => {
			const credentials = await client.getCredentials();
			return credentials && summarizeOpenAICodex(credentials);
		},
		logout: () => client.logout(),
	};
};

const copilotOps = (storage: GitHubCopilotAuthStorage, path: string): Ops => {
	const client = new GitHubCopilotOAuthClient({ storage });
	const read = async () => {
		const credentials = await storage.get();
		return credentials && summarizeGitHubCopilot(credentials);
	};
	return {
		path,
		login: async (options) => {
			const credentials = await client.login({
				...(Option.isSome(options.enterprise) && { enterpriseUrl: options.enterprise.value }),
				enableModels: options.enableModels,
				onAuth: (info) => announce(info, options.browser),
				onProgress: (message) => void process.stderr.write(`${message}\n`),
			});
			return { wire: { provider: "github-copilot", ...credentials }, summary: summarizeGitHubCopilot(credentials) };
		},
		stored: read,
		// GitHub OAuth tokens never expire, so there is nothing to refresh.
		refreshed: read,
		logout: () => client.logout(),
	};
};

export const makeOps = (provider: Provider, options: { path?: string | undefined; persist?: boolean } = {}): Ops => {
	const file = options.path === undefined ? {} : { path: options.path };
	if (provider === "openai-codex") {
		const storage = options.persist === false ? undefined : new JsonOpenAICodexAuthStorage(file);
		return codexOps(storage ?? transient, storage?.path ?? "");
	}
	const storage = options.persist === false ? undefined : new JsonGitHubCopilotAuthStorage(file);
	return copilotOps(storage ?? transient, storage?.path ?? "");
};

export const attempt = <A>(message: string, run: () => Promise<A>) =>
	Effect.tryPromise({ try: run, catch: (cause) => new OAuthError({ message, cause }) });

/** The provider named by the two mutually exclusive flags. */
export const selectProvider = (flags: {
	readonly openaiCodex: boolean;
	readonly githubCopilot: boolean;
}): Effect.Effect<Provider, InvalidInputError> => {
	const checked = checkOAuthProvider(flags);
	return checked.ok
		? Effect.succeed(checked.provider)
		: Effect.fail(new InvalidInputError({ message: checked.message }));
};

/** Reject the local-credential flags when the credentials live on a server. */
export const assertServerScope = (authFile: Option.Option<string>) =>
	Effect.gen(function* () {
		const shared = yield* Cmd.spec;
		if (Option.isSome(authFile) || Option.isSome(shared.home)) {
			return yield* new InvalidInputError({
				message: "--auth-file and --home belong on codework serve when using --server",
			});
		}
	});

/** Credential operations against this machine's auth.json. */
export const localOps = (provider: Provider, authFile: Option.Option<string>) =>
	Effect.gen(function* () {
		const shared = yield* Cmd.spec;
		const path = yield* Path.Path;
		const file = Option.isSome(authFile)
			? authFile.value
			: Option.isSome(shared.home)
				? path.join((yield* Global.resolve({ home: shared.home.value })).home, "aikit", "auth.json")
				: undefined;
		return makeOps(provider, file === undefined ? {} : { path: file });
	});

/** Run an effect against the RPC server at `url`, discharging the client. */
export const withServer = <A, E, R>(url: string, program: Effect.Effect<A, E, R>) =>
	program.pipe(Effect.provide(Client.layer(url)), Effect.scoped);

export { Client, oauthProviderLabel };
