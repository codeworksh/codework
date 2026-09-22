/**
 * Server-side OAuth credential storage.
 *
 * The CLI runs the interactive part of every login locally — a browser
 * callback or a device code cannot travel over RPC — and sends the resulting
 * credentials here, so this service only ever reads, writes, refreshes and
 * clears the server home's `auth.json`.
 */
import {
	GitHubCopilotOAuthClient,
	JsonGitHubCopilotAuthStorage,
	type GitHubCopilotOAuthCredentials,
} from "@codeworksh/aikit/oauth/github/copilot";
import {
	JsonOpenAICodexAuthStorage,
	OpenAICodexOAuthClient,
	type OpenAICodexOAuthCredentials,
} from "@codeworksh/aikit/oauth/openai/codex";
import { summarizeGitHubCopilot, summarizeOpenAICodex } from "@codeworksh/aikit/oauth/summary";
import { Global } from "@codeworksh/harness/effect";
import { Context, Effect, Layer } from "effect";
import { Contract } from "./contract.ts";

interface Interface {
	readonly save: (credentials: Contract.OAuthCredentials) => Effect.Effect<Contract.OAuthInfo, Contract.OAuthError>;
	readonly status: (provider: Contract.OAuthProvider) => Effect.Effect<Contract.OAuthInfo | null, Contract.OAuthError>;
	readonly refresh: (
		provider: Contract.OAuthProvider,
	) => Effect.Effect<Contract.OAuthInfo | null, Contract.OAuthError>;
	readonly logout: (provider: Contract.OAuthProvider) => Effect.Effect<void, Contract.OAuthError>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/cli/server/oauth/Service") {}

const message = (cause: unknown): string =>
	cause instanceof Error && cause.message.trim().length > 0 ? cause.message : String(cause);

/**
 * Re-exported so the server, the CLI and aikit all describe a login the same
 * way; `Contract.OAuthInfo` is the wire shape of {@link OAuthSummary}.
 */
export const codexInfo = summarizeOpenAICodex;
export const copilotInfo = summarizeGitHubCopilot;

export const layer = (options: { readonly home?: string | undefined } = {}) =>
	Layer.effect(
		Service,
		Effect.gen(function* () {
			const global = yield* Global.Service;
			const authFile = Global.authFile(options.home === undefined ? undefined : global.home);
			const file = authFile === undefined ? {} : { path: authFile };
			const codex = new OpenAICodexOAuthClient({ storage: new JsonOpenAICodexAuthStorage(file) });
			const copilot = new GitHubCopilotOAuthClient({ storage: new JsonGitHubCopilotAuthStorage(file) });
			const attempt = <A>(run: () => Promise<A>) =>
				Effect.tryPromise({
					try: run,
					catch: (cause) => new Contract.OAuthError({ message: message(cause) }),
				});
			const optional = <A>(run: () => Promise<A | undefined>, info: (value: A) => Contract.OAuthInfo) =>
				attempt(run).pipe(Effect.map((value) => (value === undefined ? null : info(value))));

			return Service.of({
				// The `provider` tag is routing, not a credential: it never reaches disk.
				save: (wire) => {
					if (wire.provider === "openai-codex") {
						const credentials: OpenAICodexOAuthCredentials = {
							access: wire.access,
							refresh: wire.refresh,
							expires: wire.expires,
							accountId: wire.accountId,
						};
						return attempt(() => codex.storage.set(credentials)).pipe(Effect.as(codexInfo(credentials)));
					}
					const credentials: GitHubCopilotOAuthCredentials = {
						access: wire.access,
						refresh: wire.refresh,
						expires: wire.expires,
						...(wire.enterpriseUrl === undefined ? {} : { enterpriseUrl: wire.enterpriseUrl }),
						...(wire.apiEndpoint === undefined ? {} : { apiEndpoint: wire.apiEndpoint }),
						...(wire.availableModelIds === undefined ? {} : { availableModelIds: [...wire.availableModelIds] }),
					};
					return attempt(() => copilot.storage.set(credentials)).pipe(Effect.as(copilotInfo(credentials)));
				},
				status: (provider) =>
					provider === "openai-codex"
						? optional(() => codex.storage.get(), codexInfo)
						: optional(() => copilot.storage.get(), copilotInfo),
				// GitHub OAuth tokens never expire, so a Copilot "refresh" is a read.
				refresh: (provider) =>
					provider === "openai-codex"
						? optional(() => codex.getCredentials(), codexInfo)
						: optional(() => copilot.getCredentials(), copilotInfo),
				logout: (provider) => attempt(() => (provider === "openai-codex" ? codex.logout() : copilot.logout())),
			});
		}),
	);

export * as OAuth from "./oauth.ts";
