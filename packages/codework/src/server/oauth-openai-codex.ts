import {
	JsonOpenAICodexAuthStorage,
	OpenAICodexOAuthClient,
	type OpenAICodexOAuthCredentials,
} from "@codeworksh/aikit/oauth/openai/codex";
import { Global } from "@codeworksh/harness/effect";
import { Context, Effect, Layer } from "effect";
import { Contract } from "./contract.ts";

export interface CredentialInfo {
	readonly accountId: string;
	readonly expires: number;
}

interface Interface {
	readonly save: (credentials: OpenAICodexOAuthCredentials) => Effect.Effect<CredentialInfo, Contract.OAuthError>;
	readonly status: Effect.Effect<CredentialInfo | null, Contract.OAuthError>;
	readonly refresh: Effect.Effect<CredentialInfo | null, Contract.OAuthError>;
	readonly logout: Effect.Effect<void, Contract.OAuthError>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@codeworksh/cli/server/oauth-openai-codex/Service",
) {}

const message = (cause: unknown): string =>
	cause instanceof Error && cause.message.trim().length > 0 ? cause.message : String(cause);

const info = (credentials: OpenAICodexOAuthCredentials): CredentialInfo => ({
	accountId: credentials.accountId,
	expires: credentials.expires,
});

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const global = yield* Global.Service;
		const storage = new JsonOpenAICodexAuthStorage({ path: `${global.home}/aikit/auth.json` });
		const client = new OpenAICodexOAuthClient({ storage });
		const attempt = <A>(run: () => Promise<A>) =>
			Effect.tryPromise({
				try: run,
				catch: (cause) => new Contract.OAuthError({ message: message(cause) }),
			});

		return Service.of({
			save: (credentials) => attempt(() => storage.set(credentials)).pipe(Effect.as(info(credentials))),
			status: attempt(() => storage.get()).pipe(
				Effect.map((credentials) => (credentials === undefined ? null : info(credentials))),
			),
			refresh: attempt(() => client.getCredentials()).pipe(
				Effect.map((credentials) => (credentials === undefined ? null : info(credentials))),
			),
			logout: attempt(() => client.logout()),
		});
	}),
);

export * as OpenAICodexAuth from "./oauth-openai-codex.ts";
