/* oxlint-disable effecttsgo/async-function -- the SDK takes Promise-based fetch and provider callbacks. */
/**
 * OAuth for Streamable HTTP MCP servers. The SDK runs discovery, client registration, PKCE, the code
 * exchange and refresh; this module keeps the credentials and decides when each of those happens.
 *
 * Connections never start a browser flow. They send the stored access token, refresh it when it is
 * about to expire or after a 401, and otherwise fail as needing sign-in. The user signs in with
 * `codework mcp login <name>`, which runs the authorization code flow against a loopback callback
 * or a pasted redirect URL.
 *
 * Credentials live in `<home>/mcpauth.json`, keyed by server name and URL, so the same URL under two
 * names signs in separately. Every write takes the file's lock. Servers rotate refresh tokens and a
 * token used twice loses the grant, so a refresh holds the server's own lock from reading the tokens
 * to saving new ones, across processes, and requests in one process share one refresh. Tokens that
 * changed meanwhile, refreshed elsewhere or signed in again, are used without refreshing.
 */

import {
	type AuthProvider,
	auth,
	computeScopeUnion,
	extractWWWAuthenticateParams,
	type FetchLike,
	type OAuthClientInformationMixed,
	type OAuthClientMetadata,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
	type OAuthMetadata,
	type OAuthTokens,
	UnauthorizedError,
} from "@modelcontextprotocol/client";
import type { HttpServer, OAuthConfig } from "@codeworksh/plugin/plugin/mcp";
import { Cause, Clock, Data, Duration, Effect, Exit, References, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { crypto as hostCrypto, fileSystem, hostPath } from "../host.ts";
import { Hash } from "../util/hash.ts";
import { Lock } from "../util/lock.ts";
import { McpCallback } from "./callback.ts";
import { McpClient } from "./client.ts";
import { namespace } from "./config.ts";
import { NeedsAuthError, OAuthError } from "./error.ts";
import { McpValue } from "./value.ts";

const FILENAME = "mcpauth.json";
/** How the client presents itself when it registers: authorization servers show these on consent. */
const CLIENT_NAME = "CodeWork";
const CLIENT_URI = "https://codework.sh";
const LOGO_URI = "https://codework.sh/brand/icon.png";
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
/** Redirect URI for refreshes when none is stored. Refreshing never redirects the user. */
const FALLBACK_REDIRECT_URL = `http://${CALLBACK_HOST}${CALLBACK_PATH}`;
/** Access tokens this close to expiry are refreshed before they are sent. */
const REFRESH_SKEW = Duration.seconds(30);
/** Bounds each request to the authorization server, so an unresponsive one cannot hold a lock for long. */
const REQUEST_TIMEOUT = Duration.seconds(15);
const FILE_LOCK = { stale: Duration.seconds(30), wait: Duration.seconds(30) };
/** A waiter outlasts a stale lock, so a refresh by a killed process never fails the next one. */
const REFRESH_LOCK = { stale: Duration.seconds(20), wait: Duration.seconds(25) };

/** The server's last `WWW-Authenticate` challenge, for the next sign-in. */
export interface Challenge {
	readonly scope?: string | undefined;
	readonly resourceMetadataUrl?: string | undefined;
	readonly error?: string | undefined;
}

/** What is stored for one server. */
export interface State {
	readonly clientInformation?: OAuthClientInformationMixed;
	readonly tokens?: OAuthTokens;
	/** When the access token expires, in milliseconds since the epoch, from `expires_in` when it was saved. */
	readonly tokensExpireAt?: number;
	readonly challenge?: Challenge;
}

type States = Record<string, State>;

/** The credential file holds something other than JSON. */
class Unreadable extends Data.TaggedError("McpOAuth.Unreadable")<{ readonly message: string }> {}

/**
 * A failure from the SDK, or one handed back to it. The SDK tells failures apart by class
 * (`UnauthorizedError` above all), so the original is kept and rethrown as it was.
 */
class Rejected extends Data.TaggedError("McpOAuth.Rejected")<{ readonly error: unknown }> {}

/** Run `effect` for a Promise-based SDK callback, rejecting with the original error of a failure. */
const toPromise = <A, E>(effect: Effect.Effect<A, E>) =>
	Effect.runPromiseExit(effect).then((exit) => {
		if (Exit.isSuccess(exit)) return exit.value;
		const error = Cause.squash(exit.cause);
		throw error instanceof Rejected ? error.error : error;
	});

/** A server signing in with OAuth: its name in `mcp.json`, its URL and its `oauth` settings. */
export interface Server {
	readonly name: string;
	readonly url: string;
	readonly oauth?: OAuthConfig | undefined;
}

/** Where a server's credentials are stored: by name and URL, so two names never share an account. */
export const key = (server: Pick<Server, "name" | "url">) => `${namespace(server.name)}|${String(new URL(server.url))}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const isHttp = (url: URL) => url.protocol === "http:" || url.protocol === "https:";

/** The credential file of one home, shared by every connection and sign-in of this process. */
export interface Store {
	readonly path: string;
	readonly load: (key: string) => Effect.Effect<State | undefined>;
	/** Rewrite one server's entry under the file's lock; `undefined` removes it. */
	readonly update: (
		server: string,
		key: string,
		change: (state: State | undefined) => State | undefined,
	) => Effect.Effect<void, OAuthError>;
	/** Run `effect` while no other process refreshes this server's tokens. */
	readonly withRefreshLock: <A, E, R>(
		server: string,
		key: string,
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | OAuthError, R>;
	/** The refresh this process runs for a server, so concurrent 401s share it. */
	readonly refreshing: Map<string, Promise<void>>;
}

export const store = (home: string): Store => {
	const path = hostPath.join(home, FILENAME);
	const read = fileSystem.readFileString(path).pipe(
		Effect.catchIf(
			(error) => error.reason._tag === "NotFound",
			() => Effect.succeed(""),
		),
		Effect.flatMap((text) =>
			Effect.try({
				try: (): States => {
					if (!text.trim()) return {};
					// @effect-diagnostics-next-line preferSchemaOverJson:off
					const parsed: unknown = JSON.parse(text);
					return isRecord(parsed) ? (parsed as States) : {};
				},
				catch: (error) => new Unreadable({ message: `invalid JSON: ${message(error)}` }),
			}),
		),
	);
	const failed = (server: string) => (error: unknown) =>
		new OAuthError({ server, message: `cannot update ${path}: ${message(error)}` });
	return {
		path,
		// Writes replace the file in one rename, so a read never sees half of one.
		load: (key) =>
			read.pipe(
				Effect.map((states) => states[key]),
				Effect.orElseSucceed(() => undefined),
			),
		update: (server, key, change) =>
			Effect.gen(function* () {
				yield* Lock.acquire(`${path}.lock`, FILE_LOCK, () => failed(server)("timed out waiting for its lock"));
				// A file that cannot be parsed is reported, never replaced: it holds other servers' credentials.
				const states = yield* read;
				const next = change(states[key]);
				if (next === undefined) delete states[key];
				else states[key] = next;
				const temporary = `${path}.${(yield* hostCrypto.randomUUIDv4()).slice(0, 8)}.tmp`;
				// Indented: the file is the user's to read.
				// @effect-diagnostics-next-line preferSchemaOverJson:off
				const text = `${JSON.stringify(states, null, 2)}\n`;
				yield* fileSystem.writeFileString(temporary, text, { mode: 0o600 });
				yield* fileSystem.rename(temporary, path);
			}).pipe(Effect.scoped, Effect.mapError(failed(server))),
		withRefreshLock: (server, key, effect) =>
			Effect.gen(function* () {
				const hash = Hash.sha256(key).slice(0, 16);
				yield* Lock.acquire(hostPath.join(home, `mcpauth.${hash}.lock`), REFRESH_LOCK, () =>
					failed(server)("timed out waiting for another process to refresh its tokens"),
				).pipe(Effect.catchTag("LockError", (error) => Effect.fail(failed(server)(error.message))));
				return yield* effect;
			}).pipe(Effect.scoped),
		refreshing: new Map(),
	};
};

/**
 * Bounds every request to the authorization server, and holds what it sends back to what a sign-in
 * may trust:
 *
 * - Only `http` and `https`: the authorization URL is opened by the platform's URL handler, so a
 *   `file:` or custom scheme would launch a local program.
 * - `null` and `""` in a JSON answer mean absent: servers send them for fields they have no value
 *   for, and the SDK's schemas reject them.
 * - Metadata is fetched from the well-known path alone, without the server URL's query.
 */
export const oauthFetch =
	(signal?: AbortSignal): FetchLike =>
	async (input, init) => {
		const url = new URL(String(input));
		if (!isHttp(url)) throw new Error(`Refusing to fetch ${url.protocol} URL ${url.href}`);
		if (url.pathname.includes("/.well-known/")) url.search = "";
		const signals = [AbortSignal.timeout(Duration.toMillis(REQUEST_TIMEOUT)), init?.signal, signal].filter(
			(one): one is AbortSignal => one instanceof AbortSignal,
		);
		// @effect-diagnostics-next-line globalFetch:off
		const response = await fetch(url, { ...init, signal: AbortSignal.any(signals) });
		if (!response.headers.get("content-type")?.includes("json")) return response;
		const text = await response.text();
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return new Response(text, response);
		}
		if (isRecord(body)) {
			for (const [field, value] of Object.entries(body)) if (value === null || value === "") delete body[field];
			for (const field of [
				"issuer",
				"authorization_endpoint",
				"token_endpoint",
				"registration_endpoint",
				"resource",
			])
				if (typeof body[field] === "string" && !(URL.canParse(body[field]) && isHttp(new URL(body[field]))))
					throw new Error(`Invalid ${field} ${body[field]}: only http and https URLs are accepted`);
			const servers = body.authorization_servers;
			if (
				Array.isArray(servers) &&
				servers.some((one) => !(URL.canParse(String(one)) && isHttp(new URL(String(one)))))
			)
				throw new Error("Invalid authorization server URL: only http and https URLs are accepted");
		}
		const headers = new Headers(response.headers);
		headers.delete("content-length");
		headers.delete("content-encoding");
		return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers });
	};

/** `oauth` with its client secret resolved. */
interface Settings extends Omit<OAuthConfig, "clientSecret"> {
	readonly clientSecret?: string | undefined;
}

const settings = Effect.fnUntraced(function* (server: Server) {
	const oauth = server.oauth ?? {};
	if (oauth.clientSecret === undefined) return oauth satisfies Settings;
	const clientSecret = yield* McpValue.resolve(
		oauth.clientSecret,
		"header",
		`MCP server "${server.name}" oauth.clientSecret`,
	);
	return { ...oauth, clientSecret } satisfies Settings;
});

/** Where the callback listens, and the exact redirect URI when the port is fixed. */
const callbackOf = (oauth: Settings) => {
	const url = new URL(oauth.callbackUrl ?? `http://${CALLBACK_HOST}${CALLBACK_PATH}`);
	const host = url.hostname.replace(/^\[|\]$/g, "");
	const port = url.port ? Number(url.port) : oauth.callbackPort;
	let fixed: string | undefined;
	// A configured URI with a port is sent exactly as written, since servers compare it as a string.
	if (url.port) fixed = oauth.callbackUrl;
	else if (port !== undefined) {
		url.port = String(port);
		fixed = url.href;
	}
	return {
		// `localhost` is served on 127.0.0.1; browsers fall back to it when ::1 refuses.
		host: host === "localhost" ? CALLBACK_HOST : host,
		redirectHost: host,
		port,
		path: url.pathname,
		fixed,
	};
};

const registered = (client: OAuthClientInformationMixed | undefined): ReadonlyArray<string> =>
	client !== undefined && "redirect_uris" in client ? client.redirect_uris : [];

/** Authorization server metadata from a configured URL, standing in for discovery through the server. */
const configuredDiscovery = async (url: string, server: string, fetchFn: FetchLike) => {
	const response = await fetchFn(url, { headers: { accept: "application/json" } });
	if (!response.ok) throw new Error(`HTTP ${response.status} loading authorization server metadata from ${url}`);
	const metadata = (await response.json()) as OAuthMetadata;
	if (typeof metadata.issuer !== "string" || typeof metadata.authorization_endpoint !== "string")
		throw new Error(`${url} is not authorization server metadata`);
	return {
		authorizationServerUrl: metadata.issuer,
		authorizationServerMetadata: metadata,
		resourceMetadata: { resource: server },
	} satisfies OAuthDiscoveryState;
};

/**
 * The SDK's view of one server's credentials, for one run of `auth()`. Without `onRedirect` it
 * refuses to send the user anywhere, which ends a refresh that cannot succeed as needing sign-in.
 */
const provider = (input: {
	readonly store: Store;
	readonly server: Server;
	readonly settings: Settings;
	readonly redirectUrl: string;
	readonly fetchFn: FetchLike;
	readonly state?: string;
	readonly onRedirect?: (url: URL) => void;
}) => {
	const { store, server, settings: oauth } = input;
	const id = key(server);
	const save = (change: (state: State | undefined) => State | undefined) =>
		toPromise(store.update(server.name, id, change));
	// The credentials this run read or saved. Another process may store newer ones while the server
	// refuses ours; those are not ours to drop. A server may keep the access token and rotate only the
	// refresh token, so both are compared.
	const presented: { access?: string; refresh?: string; client?: string } = {};
	const presents = (tokens: OAuthTokens | undefined) => {
		presented.access = tokens?.access_token;
		presented.refresh = tokens?.refresh_token;
	};
	const isPresented = (state: State | undefined, scope: "all" | "client" | "tokens") =>
		state?.tokens?.access_token === presented.access &&
		state?.tokens?.refresh_token === presented.refresh &&
		(scope === "tokens" || state?.clientInformation?.client_id === presented.client);
	let verifier: string | undefined;
	let discovery: OAuthDiscoveryState | undefined;
	const clientMetadata: OAuthClientMetadata = {
		redirect_uris: [input.redirectUrl],
		client_name: oauth.clientName ?? CLIENT_NAME,
		client_uri: CLIENT_URI,
		logo_uri: LOGO_URI,
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: oauth.clientSecret === undefined ? "none" : "client_secret_post",
		...(oauth.scope === undefined ? {} : { scope: oauth.scope }),
	};
	const sdk: OAuthClientProvider = {
		redirectUrl: input.redirectUrl,
		clientMetadata,
		...(input.state === undefined ? {} : { state: () => input.state! }),
		clientInformation: async () => {
			if (oauth.clientId !== undefined)
				return {
					client_id: oauth.clientId,
					...(oauth.clientSecret === undefined ? {} : { client_secret: oauth.clientSecret }),
				};
			const clientInformation = (await toPromise(store.load(id)))?.clientInformation;
			presented.client = clientInformation?.client_id;
			return clientInformation;
		},
		saveClientInformation: (clientInformation) => {
			presented.client = clientInformation.client_id;
			return save((state) => ({ ...state, clientInformation }));
		},
		tokens: async () => {
			const tokens = (await toPromise(store.load(id)))?.tokens;
			presents(tokens);
			return tokens;
		},
		saveTokens: (tokens) => {
			presents(tokens);
			return save((state) => {
				const { tokensExpireAt: _expired, ...rest } = state ?? {};
				return {
					...rest,
					tokens,
					// @effect-diagnostics-next-line globalDate:off
					...(tokens.expires_in === undefined ? {} : { tokensExpireAt: Date.now() + tokens.expires_in * 1000 }),
				};
			});
		},
		redirectToAuthorization: (url) => {
			if (!isHttp(url)) throw new Error(`Refusing to open ${url.protocol} authorization URL`);
			if (input.onRedirect === undefined)
				throw new UnauthorizedError(`MCP server "${server.name}" requires sign-in`);
			input.onRedirect(url);
		},
		saveCodeVerifier: (value) => {
			verifier = value;
		},
		codeVerifier: () => {
			if (verifier === undefined) throw new Error("No PKCE code verifier for this sign-in");
			return verifier;
		},
		discoveryState: async () => {
			if (discovery === undefined && oauth.authServerMetadataUrl !== undefined)
				discovery = await configuredDiscovery(oauth.authServerMetadataUrl, server.url, input.fetchFn);
			return discovery;
		},
		saveDiscoveryState: (state) => {
			discovery = state;
		},
		invalidateCredentials: async (scope) => {
			if (scope === "verifier") verifier = undefined;
			else if (scope === "discovery") discovery = undefined;
			else
				// Compared under the file's lock, which every writer of the file takes.
				await save((state) => {
					if (!isPresented(state, scope)) return state;
					if (state === undefined || scope === "all") return undefined;
					if (scope === "client") {
						const { clientInformation: _client, ...rest } = state;
						return rest;
					}
					const { tokens: _tokens, tokensExpireAt: _expires, ...rest } = state;
					return rest;
				});
		},
	};
	return { sdk, discovery: () => discovery };
};

const authorize = (run: () => Promise<"AUTHORIZED" | "REDIRECT">) =>
	Effect.tryPromise({ try: run, catch: (error) => new Rejected({ error }) });

const unauthorized = (server: Server, why = "requires sign-in") =>
	new Rejected({ error: new UnauthorizedError(`MCP server "${server.name}" ${why}`) });

/**
 * Bearer tokens for one server's connections. `token` reads the store before every request, so a
 * sign-in or refresh by any process applies at once.
 */
export const connection = Effect.fn("McpOAuth.connection")(function* (input: {
	readonly store: Store;
	readonly server: Server;
	/** The server asked for more scope; the next sign-in requests it. */
	readonly onChallenge?: (challenge: Challenge) => void;
}) {
	const { store, server } = input;
	const id = key(server);
	const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
	const run = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>) =>
		toPromise(effect.pipe(Effect.provide(context)));
	// The token the last request carried: a different stored one means another request refreshed it.
	let sent: string | undefined;

	/** Replace `stale`, the access token that expired or was rejected. */
	const refresh = (stale: string | undefined, challenge?: Challenge) => {
		let shared = store.refreshing.get(id);
		if (shared !== undefined) return shared;
		const work = store.withRefreshLock(
			server.name,
			id,
			Effect.gen(function* () {
				const state = yield* store.load(id);
				if (state?.tokens?.access_token !== stale) return;
				if (state?.tokens?.refresh_token === undefined) return yield* unauthorized(server);
				const oauth = yield* settings(server);
				const redirectUrl =
					callbackOf(oauth).fixed ?? registered(state.clientInformation)[0] ?? FALLBACK_REDIRECT_URL;
				const fetchFn = oauthFetch();
				const { sdk } = provider({ store, server, settings: oauth, redirectUrl, fetchFn });
				// Not cancellable: a refresh the server answered may have rotated the refresh token, and its
				// answer must be saved.
				const result = yield* authorize(() =>
					auth(sdk, {
						serverUrl: server.url,
						fetchFn,
						...(challenge?.resourceMetadataUrl === undefined
							? {}
							: { resourceMetadataUrl: new URL(challenge.resourceMetadataUrl) }),
						...(challenge?.scope === undefined ? {} : { scope: challenge.scope }),
					}),
				);
				if (result === "REDIRECT") return yield* unauthorized(server);
			}),
		);
		shared = run(work).finally(() => {
			if (store.refreshing.get(id) === shared) store.refreshing.delete(id);
		});
		store.refreshing.set(id, shared);
		return shared;
	};

	const bearer: AuthProvider = {
		token: async () => {
			await store.refreshing.get(id)?.catch(() => undefined);
			const state = await toPromise(store.load(id));
			const token = state?.tokens?.access_token;
			const expires = state?.tokensExpireAt;
			const now = await toPromise(Clock.currentTimeMillis);
			if (
				expires === undefined ||
				expires - Duration.toMillis(REFRESH_SKEW) > now ||
				!state?.tokens?.refresh_token
			) {
				sent = token;
				return token;
			}
			// Failures fall through: the request goes out with the old token and a 401 decides what happens.
			await refresh(token).catch(() => undefined);
			sent = (await toPromise(store.load(id)))?.tokens?.access_token;
			return sent;
		},
		onUnauthorized: async ({ response }) => {
			const params = extractWWWAuthenticateParams(response);
			const challenge: Challenge = {
				scope: params.scope,
				resourceMetadataUrl: params.resourceMetadataUrl?.href,
				error: params.error,
			};
			await toPromise(remember(store, server, challenge)).catch(() => undefined);
			// A refresh keeps the granted scope, so more scope needs a new sign-in.
			if (params.error === "insufficient_scope")
				throw new UnauthorizedError(`MCP server "${server.name}" requires sign-in for more scope`);
			await refresh(sent, challenge);
		},
	};
	return bearer;
});

/** Keep the server's latest challenge for the next sign-in; unchanged ones are not written again. */
export const remember = (store: Store, server: Server, challenge: Challenge) =>
	Effect.gen(function* () {
		const id = key(server);
		const current = (yield* store.load(id))?.challenge;
		if (
			current?.scope === challenge.scope &&
			current?.resourceMetadataUrl === challenge.resourceMetadataUrl &&
			current?.error === challenge.error
		)
			return;
		yield* store.update(server.name, id, (state) => ({ ...state, challenge }));
	});

/** Stored tokens of the server, to notice a sign-in done by another process. */
export const accessToken = (store: Store, server: Server) =>
	store.load(key(server)).pipe(Effect.map((state) => state?.tokens?.access_token));

/** How a sign-in reaches the user. */
export interface Prompt {
	/** Show the authorization URL, and open it in a browser. */
	readonly show: (url: URL) => Effect.Effect<void>;
	/**
	 * The redirect URL from the browser's address bar, for a browser that cannot reach the loopback
	 * callback (over SSH, say). `undefined` cancels the sign-in. Interrupted once the callback arrives.
	 */
	readonly paste: Effect.Effect<string | undefined>;
}

const fromRedirectUrl = (server: string, input: string, state: string, redirectUrl: URL) => {
	const fail = (text: string) => Effect.fail(new OAuthError({ server, message: text }));
	if (!URL.canParse(input.trim())) return fail("Expected the full redirect URL from the browser's address bar");
	const url = new URL(input.trim());
	if (url.origin !== redirectUrl.origin || url.pathname !== redirectUrl.pathname)
		return fail("The redirect URL does not match this sign-in's redirect URI");
	const error = url.searchParams.get("error");
	if (error !== null) return fail(url.searchParams.get("error_description") ?? error);
	if (url.searchParams.get("state") !== state) return fail("The redirect URL belongs to a different sign-in");
	const code = url.searchParams.get("code");
	if (code === null) return fail("The redirect URL has no authorization code");
	return Effect.succeed({ code, iss: url.searchParams.get("iss") ?? undefined });
};

/**
 * Sign in to a server: refresh the stored tokens when that is enough, otherwise run the browser
 * authorization code flow. Interrupting it cancels every step.
 */
export const signIn = Effect.fn("McpOAuth.signIn")(function* (input: {
	readonly store: Store;
	readonly server: Server;
	readonly prompt: Prompt;
}) {
	const { store, server, prompt } = input;
	const id = key(server);
	const fail = (error: unknown) =>
		Schema.is(OAuthError)(error)
			? error
			: new OAuthError({ server: server.name, message: message(error instanceof Rejected ? error.error : error) });
	// Aborted when the sign-in ends or is interrupted, which cancels any request still running.
	const signal = yield* Effect.abortSignal;
	const stored = yield* store.load(id);
	const challenge = stored?.challenge;
	const stepUp = challenge?.error === "insufficient_scope";
	const oauth = yield* settings(server).pipe(Effect.mapError(fail));
	const where = callbackOf(oauth);
	// Reuse the port of the registered redirect URI, so the registered client stays valid.
	const first = registered(stored?.clientInformation)[0];
	const port = where.port ?? (first === undefined ? undefined : Number(new URL(first).port) || undefined);
	const callback = yield* McpCallback.listen({ ...where, port }, where.port !== undefined).pipe(Effect.mapError(fail));
	const redirectUrl = where.fixed ?? callback.redirectUrl;
	if (stored !== undefined) {
		// A registered client cannot use another redirect URI, and its tokens belong to it.
		const keep = oauth.clientId !== undefined || registered(stored.clientInformation).includes(redirectUrl);
		if (!keep)
			yield* store.update(
				server.name,
				id,
				({ clientInformation: _c, tokens: _t, tokensExpireAt: _e, ...rest } = {}) => rest,
			);
	}

	const state = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
	let authorizationUrl: URL | undefined;
	const fetchFn = oauthFetch(signal);
	const flow = provider({
		store,
		server,
		settings: oauth,
		redirectUrl,
		fetchFn,
		state,
		onRedirect: (url) => {
			authorizationUrl = url;
		},
	});
	// More scope comes on top of the configured scope and, since the challenge may list only the
	// missing scopes, on top of the scope granted so far.
	const scope = computeScopeUnion(
		oauth.scope,
		stepUp ? computeScopeUnion(stored?.tokens?.scope, challenge?.scope) : challenge?.scope,
	);
	const options = {
		serverUrl: server.url,
		fetchFn,
		...(challenge?.resourceMetadataUrl === undefined
			? {}
			: { resourceMetadataUrl: new URL(challenge.resourceMetadataUrl) }),
		...(scope === undefined ? {} : { scope }),
	};
	const done = store.update(server.name, id, ({ challenge: _challenge, ...rest } = {}) => rest);

	// A refresh keeps the granted scope; a server asking for more needs the browser flow.
	if (
		(yield* authorize(() => auth(flow.sdk, { ...options, forceReauthorization: stepUp })).pipe(
			Effect.mapError(fail),
		)) === "AUTHORIZED"
	)
		return yield* done;
	if (authorizationUrl === undefined)
		return yield* new OAuthError({ server: server.name, message: "The server did not provide an authorization URL" });

	// The flow picks the redirect URI, which may be specific to the server.
	const expected = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? redirectUrl);
	yield* prompt.show(authorizationUrl);
	const response = yield* Effect.raceFirst(
		callback.wait(state).pipe(Effect.mapError(fail)),
		prompt.paste.pipe(
			Effect.flatMap((pasted) =>
				pasted?.trim()
					? fromRedirectUrl(server.name, pasted, state, expected)
					: Effect.fail(new OAuthError({ server: server.name, message: "Sign-in cancelled" })),
			),
		),
	);
	// The SDK checks `iss` only against discovered metadata; one without metadata to check against
	// may come from another authorization server (RFC 9207).
	if (response.iss !== undefined && flow.discovery()?.authorizationServerMetadata === undefined)
		return yield* new OAuthError({
			server: server.name,
			message: `The authorization response names issuer ${response.iss}, but no authorization server metadata was discovered to check it against`,
		});
	yield* authorize(() =>
		auth(flow.sdk, {
			...options,
			authorizationCode: response.code,
			...(response.iss === undefined ? {} : { iss: response.iss }),
		}),
	).pipe(Effect.mapError(fail));
	yield* done;
}, Effect.scoped);

/**
 * Sign in to a server the way `codework mcp login` does. Connecting first tells whether a sign-in is
 * needed and records the server's challenge, whose resource metadata URL and scope the sign-in
 * uses. A stored step-up challenge always signs in: a connection may succeed while a call needs
 * more scope. Returns whether it signed in, and the tools the server offers afterwards.
 */
export const login = Effect.fn("McpOAuth.login")(function* (input: {
	readonly store: Store;
	readonly name: string;
	readonly config: HttpServer;
	readonly prompt: Prompt;
}) {
	const { store, name, config, prompt } = input;
	const server: Server = { name, url: config.url, oauth: config.oauth };
	const connect = Effect.gen(function* () {
		const headers = yield* McpValue.resolveAll(config.headers ?? {}, "header", `MCP server "${name}" header`);
		const client = yield* McpClient.connect({
			server: name,
			endpoint: { _tag: "Http", url: new URL(config.url), headers },
			authProvider: yield* connection({ store, server }),
			...(config.timeout === undefined ? {} : { timeout: { request: Duration.seconds(config.timeout) } }),
		});
		return (yield* client.tools()).length;
	}).pipe(Effect.scoped);

	// Expected to fail when a sign-in is needed; its transport warnings would only be noise.
	const first = yield* Effect.exit(connect.pipe(Effect.provideService(References.MinimumLogLevel, "Error")));
	const stepUp = (yield* store.load(key(server)))?.challenge?.error === "insufficient_scope";
	if (Exit.isSuccess(first) && !stepUp) return { signedIn: false, tools: first.value };
	if (Exit.isFailure(first)) {
		const error = Cause.squash(first.cause);
		if (!Schema.is(NeedsAuthError)(error))
			return yield* new OAuthError({ server: name, message: `failed to connect: ${message(error)}` });
		if (error.scope !== undefined)
			yield* remember(store, server, {
				scope: error.scope,
				resourceMetadataUrl: error.resourceMetadataUrl,
				error: "insufficient_scope",
			});
	}
	yield* signIn({ store, server, prompt });
	const tools = yield* connect.pipe(
		Effect.mapError((error) => new OAuthError({ server: name, message: `signed in, but ${message(error)}` })),
	);
	return { signedIn: true, tools };
});

/** Remove the server's stored credentials. Returns whether there were any. */
export const signOut = Effect.fn("McpOAuth.signOut")(function* (store: Store, server: Pick<Server, "name" | "url">) {
	const id = key(server);
	const existed = (yield* store.load(id)) !== undefined;
	if (existed) yield* store.update(server.name, id, () => undefined);
	return existed;
});

export * as McpOAuth from "./oauth.ts";
