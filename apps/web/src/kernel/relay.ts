import { Relay } from "@codeworksh/schema";
import { Context, Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { AsyncResult, Atom } from "effect/reactivity";

const configured: unknown = import.meta.env.CODEWORK_RELAY_URL;
/** The relay the app talks to; `CODEWORK_RELAY_URL` in the repo's .env.local points a dev build elsewhere. */
const relayUrl = typeof configured === "string" && configured !== "" ? configured : "https://relay.codework.sh";

// The signed-in person's session token, read fresh for each call (Clerk's tokens live a minute). The auth
// gate sets it once Clerk has loaded; until then calls go without one and the relay refuses them.
let sessionToken: () => Promise<string | null> = () => Promise.resolve(null);
export const setSessionToken = (source: () => Promise<string | null>) => {
	sessionToken = source;
};

class Client extends Context.Service<Client, HttpApiClient.ForApi<typeof Relay.Api>>()("codework/web/Relay") {
	static readonly layer = Layer.effect(
		Client,
		HttpApiClient.make(Relay.Api, {
			baseUrl: relayUrl,
			transformClient: HttpClient.mapRequestEffect((request) =>
				Effect.promise(() => sessionToken()).pipe(
					Effect.map((token) => (token === null ? request : HttpClientRequest.bearerToken(request, token))),
				),
			),
		}),
	).pipe(Layer.provide(FetchHttpClient.layer));
}

const runtime = Atom.runtime(Client.layer);

/** The signed-in account and the workspaces it belongs to. */
export const meAtom = runtime
	.atom(
		Effect.gen(function* () {
			const client = yield* Client;
			return yield* client.me.get();
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
