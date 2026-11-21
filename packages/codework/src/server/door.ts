import { Forwarded, Door as Knock } from "@codeworksh/schema";
import { Context, Deferred, Effect, Layer, Option } from "effect";
import { Headers, HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import { RpcServer } from "effect/rpc";
import * as Contract from "./contract.ts";
import * as Pairing from "./pairing.ts";
import * as Principal from "./principal.ts";

/**
 * How a caller gets in, and stays in only as long as it may. The door judges a socket's credential
 * once, before the upgrade, and files the connection under a key it adds to the upgrade request as
 * {@link header}. The upgrade request's headers come with every call on that socket, so each call
 * finds its caller by that key. A key never leaves the server, so a client cannot claim another
 * connection by sending one in a call's own headers, which would override the upgrade's.
 */
export const header = "x-codework-connection";

interface Connection {
	readonly principal: Principal.Principal;
	readonly ended: Deferred.Deferred<void>;
}

/** The connections the door let in, by key. */
export class Connections extends Context.Service<
	Connections,
	{
		/** Files a connection for `principal`, answering its key. */
		readonly open: (principal: Principal.Principal) => Effect.Effect<string>;
		/** Who is on the connection `key` names; none once it ended. */
		readonly find: (key: string | undefined) => Principal.Principal | undefined;
		/** The keys of a device's open connections. */
		readonly device: (id: string) => ReadonlyArray<string>;
		/** Ends a connection: its calls stop, and its socket closes. */
		readonly end: (key: string) => Effect.Effect<void>;
		/** Runs `effect`, the connection's socket, until it finishes or the connection is ended. */
		readonly serve: <E, R>(
			key: string,
			effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
		) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>;
	}
>()("@codeworksh/cli/server/door/Connections") {}

export const layerConnections = Layer.sync(Connections, () => {
	const held = new Map<string, Connection>();
	const end = (key: string) =>
		Effect.suspend(() => {
			const connection = held.get(key);
			held.delete(key);
			return connection === undefined ? Effect.void : Deferred.succeed(connection.ended, undefined);
		});
	return Connections.of({
		open: (principal) =>
			Effect.gen(function* () {
				const key = yield* Knock.make;
				held.set(key, { principal, ended: yield* Deferred.make<void>() });
				return key;
			}),
		find: (key) => (key === undefined ? undefined : held.get(key)?.principal),
		device: (id) =>
			[...held].flatMap(([key, { principal }]) => (principal.kind === "device" && principal.id === id ? [key] : [])),
		end,
		serve: (key, effect) => {
			const connection = held.get(key);
			if (connection === undefined) return Effect.succeed(HttpServerResponse.empty({ status: 401 }));
			return Effect.raceFirst(
				effect,
				Deferred.await(connection.ended).pipe(Effect.as(HttpServerResponse.empty())),
			).pipe(Effect.ensuring(end(key)));
		},
	});
});

/** Whether `request` comes from this computer, by its peer address: no header can say so. */
const fromLoopback = (request: HttpServerRequest.HttpServerRequest) => {
	const peer = Forwarded.peer(request);
	return peer !== undefined && NetAddress.isLoopback(peer);
};

const pathname = (request: HttpServerRequest.HttpServerRequest) => new URL(request.url, "http://localhost").pathname;

/**
 * The listener's door before any upgrade: no browser origin is served. The pairing routes take no
 * credential here, as each checks its own. The socket takes the home's token from a loopback peer,
 * or a live ticket, which it spends.
 */
export const listener = Layer.unwrap(
	Effect.gen(function* () {
		const token = yield* Principal.Token;
		const pairing = yield* Pairing.Service;
		const connections = yield* Connections;
		const caller = (offered: string, request: HttpServerRequest.HttpServerRequest) =>
			Knock.matches(offered, token)
				? Effect.succeed<Principal.Principal | undefined>(fromLoopback(request) ? { kind: "local" } : undefined)
				: Effect.map(pairing.redeem(offered), (id) =>
						id === undefined ? undefined : ({ kind: "device", id } as const),
					);
		return Knock.layer({
			origins: [],
			admit: (offered, request) =>
				Effect.gen(function* () {
					const path = pathname(request);
					if (request.method === "POST" && Pairing.paths.includes(path)) return request;
					if (request.method !== "GET" || path !== Contract.path || offered === undefined) return undefined;
					const principal = yield* caller(offered, request);
					if (principal === undefined) return undefined;
					const key = yield* connections.open(principal);
					return request.modify({ headers: Headers.set(request.headers, header, key) });
				}),
		});
	}),
);

/** The socket route of the RPC server: each connection runs until it closes or is ended. */
export const protocol = Layer.effect(
	RpcServer.Protocol,
	Effect.gen(function* () {
		const { httpEffect, protocol } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
		const connections = yield* Connections;
		const router = yield* HttpRouter.HttpRouter;
		yield* router.add("GET", Contract.path, (request) =>
			// Scoped here, so ending the connection closes its socket and drops its calls at once.
			connections.serve(request.headers[header] ?? "", Effect.scoped(httpEffect)),
		);
		return protocol;
	}),
);

/** The door on every call: the caller of the connection it came on, which must still be open. */
export const rpc = Layer.effect(
	Principal.Door,
	Effect.gen(function* () {
		const connections = yield* Connections;
		return Principal.Door.of((effect, { headers }) => {
			const principal = connections.find(Option.getOrUndefined(Headers.get(headers, header)));
			return principal === undefined
				? Effect.fail(new Principal.Unauthorized({ message: "This connection is not open to this server" }))
				: Effect.provideService(effect, Principal.Current, principal);
		});
	}),
);
