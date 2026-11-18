import { Relay } from "@codeworksh/schema";
import { Cause, Context, Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { AsyncResult, Atom } from "effect/reactivity";

import { messageOf } from "@/lib/utils";

const configured: unknown = import.meta.env.CODEWORK_RELAY_URL;
/** The relay the app talks to; `CODEWORK_RELAY_URL` in the repo's .env.local points a dev build elsewhere. */
const relayUrl = typeof configured === "string" && configured !== "" ? configured : "https://relay.codework.sh";

// The signed-in person's session token, read fresh for each call (Clerk's tokens live a minute). The auth
// gate sets it once Clerk has loaded; until then calls go without one and the relay refuses them.
type TokenSource = (options?: { readonly skipCache?: boolean }) => Promise<string | null>;
let sessionToken: TokenSource = () => Promise.resolve(null);
/** Where the signed-in person's account is remembered on this device, so it shows while out of reach. */
let accountKey: string | undefined;
export const setSession = (source: TokenSource, userId: string | null | undefined) => {
	sessionToken = source;
	accountKey = userId == null ? undefined : `codework.account.${userId}`;
};

const remembered = (): Relay.Me | undefined => {
	try {
		const saved = accountKey === undefined ? null : localStorage.getItem(accountKey);
		return saved === null ? undefined : Schema.decodeUnknownSync(Relay.Me)(JSON.parse(saved));
	} catch {
		// Unreadable or from an older shape: nothing remembered.
		return undefined;
	}
};
const remember = (me: Relay.Me) => {
	try {
		if (accountKey !== undefined) localStorage.setItem(accountKey, JSON.stringify(Schema.encodeSync(Relay.Me)(me)));
	} catch {
		// Unsaved, the account still shows until the app quits.
	}
};

/**
 * Whether the relay answers, as the latest call to it found: `unreachable` (no answer at all) or
 * `unavailable` (it answered that its sign-in vendor is out of reach).
 */
export type Reach = "ok" | "unreachable" | "unavailable";
let reach: Reach = "ok";
const reachListeners = new Set<(next: Reach) => void>();
const report = (next: Reach) => {
	if (next === reach) return;
	reach = next;
	for (const listener of reachListeners) listener(next);
};
export const reachAtom = Atom.make((get) => {
	const listener = (next: Reach) => get.setSelf(next);
	reachListeners.add(listener);
	get.addFinalizer(() => reachListeners.delete(listener));
	return reach;
}).pipe(Atom.keepAlive);

/** No session token yet: Clerk is still loading or unreachable. Worth asking again. */
class SessionPending extends Schema.TaggedError<SessionPending>()("Relay.SessionPending", {
	message: Schema.String,
}) {}
const pending = () => new SessionPending({ message: "Waiting for your sign-in to load" });
/** The current token, or none when Clerk can't give one (still loading, offline). */
const currentToken = Effect.tryPromise(() => sessionToken()).pipe(Effect.orElseSucceed(() => null));

class Client extends Context.Service<Client, HttpApiClient.ForApi<typeof Relay.Api>>()("codework/web/Relay") {
	static readonly layer = Layer.effect(
		Client,
		HttpApiClient.make(Relay.Api, {
			baseUrl: relayUrl,
			transformClient: (client) =>
				client.pipe(
					HttpClient.mapRequestEffect((request) =>
						currentToken.pipe(
							Effect.map((token) => (token === null ? request : HttpClientRequest.bearerToken(request, token))),
						),
					),
					// Every answer, and every call that got none, says whether the relay is in reach.
					HttpClient.tap((response) => Effect.sync(() => report(response.status === 503 ? "unavailable" : "ok"))),
					HttpClient.tapError((error) =>
						Effect.sync(() => {
							if (error.reason._tag === "TransportError") report("unreachable");
						}),
					),
				),
		}),
	).pipe(Layer.provide(FetchHttpClient.layer));
}

const runtime = Atom.runtime(Client.layer);

const isUnauthorized = Schema.is(Relay.Unauthorized);

const unreachable = /transport error|fetch failed|econnrefused|enotfound|etimedout|network/i;

/** A relay failure in people's words: a network failure reads as one; the relay's own message otherwise. */
export const relayFailure = (cause: unknown) => {
	if (isUnauthorized(Cause.isCause(cause) ? Cause.squash(cause) : cause))
		return "Your sign-in expired. Sign in again.";
	const message = messageOf(cause);
	return unreachable.test(message)
		? "Can't reach CodeWork's servers. Check your connection, then try again."
		: message;
};

/** A failure that passes on its own: the relay or its sign-in vendor out of reach, or no session yet. */
export const isTransient = (cause: unknown) => {
	const error = Cause.isCause(cause) ? Cause.squash(cause) : cause;
	return (
		Schema.is(Relay.Unavailable)(error) ||
		Schema.is(SessionPending)(error) ||
		(HttpClientError.isHttpClientError(error) && error.reason._tag === "TransportError")
	);
};

/** The relay refused the session even with a fresh token: the person has to sign in again. */
export const isSignedOut = (cause: unknown) => isUnauthorized(Cause.isCause(cause) ? Cause.squash(cause) : cause);

/**
 * The signed-in account and the workspaces it belongs to. A refused session gets one more try with a
 * fresh token (it may only be stale after sleep). Out of reach, it is what the relay last said on this
 * device, and the status slot says so; it fails only when nothing was remembered yet.
 */
export const meAtom = runtime
	.atom(
		Effect.gen(function* () {
			const client = yield* Client;
			// Without a session yet there is nothing to ask the relay with; wait for one.
			const get = Effect.gen(function* () {
				if ((yield* currentToken) === null) return yield* pending();
				return yield* client.me.get();
			});
			return yield* get.pipe(
				Effect.catchIf(isUnauthorized, () =>
					Effect.promise(() => sessionToken({ skipCache: true }).catch(() => null)).pipe(Effect.andThen(get)),
				),
				Effect.tap((me) => Effect.sync(() => remember(me))),
				Effect.catchIf(isTransient, (error) => {
					const known = remembered();
					return known === undefined ? Effect.fail(error) : Effect.succeed(known);
				}),
			);
		}),
	)
	.pipe(Atom.keepAlive);

const workspaceKey = "codework.workspace";

const savedWorkspace = () => {
	try {
		return localStorage.getItem(workspaceKey) ?? undefined;
	} catch {
		// Storage can be unavailable; the first workspace is used.
		return undefined;
	}
};

/** The workspace picked in this app, remembered across launches. */
const chosenAtom = Atom.writable(
	() => savedWorkspace(),
	(ctx, id: string) => {
		try {
			localStorage.setItem(workspaceKey, id);
		} catch {
			// Unsaved, the choice still holds until the app quits.
		}
		ctx.setSelf(id);
	},
);

/** Picks the workspace the app works in. */
export const chooseWorkspaceAtom = Atom.writable(
	() => undefined,
	(ctx, id: string) => ctx.set(chosenAtom, id),
);

/** The workspace the app works in: the one picked, while the account still belongs to it, else the first. */
export const workspaceAtom = Atom.make((get) => {
	const chosen = get(chosenAtom);
	return AsyncResult.map(
		get(meAtom),
		(me) => me.workspaces.find((workspace) => workspace.id === chosen) ?? me.workspaces[0],
	);
});

/** Creates a workspace the account owns and switches the app to it. */
export const createWorkspaceAtom = runtime.fn((name: string, get) =>
	Effect.gen(function* () {
		const client = yield* Client;
		const workspace = yield* client.workspace.create({ payload: { name } });
		get.set(chosenAtom, workspace.id);
		get.refresh(meAtom);
		return workspace;
	}),
);

/** Approves a machine's connect code for a workspace the account belongs to. */
export const approveAtom = runtime.fn((input: { readonly userCode: string; readonly workspaceId: string }) =>
	Effect.gen(function* () {
		const client = yield* Client;
		return yield* client.workspace.approve({ payload: input });
	}),
);

/** The machines connected to a workspace, as the relay last heard from them. */
export const machinesAtom = Atom.family((workspaceId: string) =>
	runtime.atom(
		Effect.gen(function* () {
			const client = yield* Client;
			return yield* client.workspace.machines({ params: { workspaceId } });
		}),
	),
);

/** A workspace's pending connects: machines that ran `codework connect --workspace` and wait for approval. */
export const pairingsAtom = Atom.family((workspaceId: string) =>
	runtime.atom(
		Effect.gen(function* () {
			const client = yield* Client;
			return yield* client.workspace.pairings({ params: { workspaceId } });
		}),
	),
);

/** Turns a pending connect away. */
export const declineAtom = runtime.fn((input: { readonly userCode: string; readonly workspaceId: string }) =>
	Effect.gen(function* () {
		const client = yield* Client;
		return yield* client.workspace.decline({ payload: input });
	}),
);

/** Disconnects another machine from a workspace, as its owner or a workspace owner or admin. */
export const removeMachineAtom = runtime.fn((input: { readonly workspaceId: string; readonly machineId: string }) =>
	Effect.gen(function* () {
		const client = yield* Client;
		return yield* client.workspace.remove({ params: input });
	}),
);
