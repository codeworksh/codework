import { Effect } from "effect";
import { Base64Url } from "effect/encoding";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

// Who may open a CodeWork listener's WebSocket. A browser WebSocket cannot set headers, so the token
// travels as the second offered subprotocol, after the fixed name the listener selects: `ws` answers
// with the first one offered, so the token is never echoed back.

/** The subprotocol every client offers first, and the one a listener selects. */
const protocol = "codework";

/** The subprotocols a client offers: the fixed name, then its token; without one it is refused. */
export const protocols = (token: string | undefined): Array<string> =>
	token === undefined ? [protocol] : [protocol, token];

/** A token as a subprotocol can carry it: base64url, which is what {@link make} gives. */
export const isToken = (value: string) => /^[A-Za-z0-9_-]+$/.test(value);

/** A fresh token: 32 random bytes. */
export const make = Effect.sync(() => Base64Url.encode(crypto.getRandomValues(new Uint8Array(32))));

/** The token a `Sec-WebSocket-Protocol` header offers after the fixed name, and nothing else; none otherwise. */
export const offered = (header: string | undefined): string | undefined => {
	const [name, token, ...rest] = (header ?? "").split(",").map((part) => part.trim());
	return name === protocol && token !== undefined && isToken(token) && rest.length === 0 ? token : undefined;
};

/** Whether `given` is `expected`, in a time that depends on `expected`'s length alone. */
export const matches = (given: string, expected: string) => {
	let difference = given.length ^ expected.length;
	// Past its end `given` reads NaN, which `| 0` turns into 0.
	for (let index = 0; index < expected.length; index++)
		difference |= expected.charCodeAt(index) ^ (given.charCodeAt(index) | 0);
	return difference === 0;
};

/**
 * How a listener judges the credential a request offers, if any: it lets the request in as it came
 * or changed for the routes behind (a header they read), or turns it away with 401 by answering none.
 */
export type Admit = (
	offered: string | undefined,
	request: HttpServerRequest.HttpServerRequest,
) => Effect.Effect<HttpServerRequest.HttpServerRequest | undefined>;

/** Admits a request that offers `expected`, and nothing else. */
export const token =
	(expected: string): Admit =>
	(given, request) =>
		Effect.succeed(given !== undefined && matches(given, expected) ? request : undefined);

/** The names a loopback listener on `port` answers to. */
const loopback = (port: number) => ["127.0.0.1", "localhost", "[::1]"].map((name) => `${name}:${port}`);

/**
 * The door on every request the listener serves, before a WebSocket upgrade: a refused one gets a
 * plain HTTP status instead of 101, 403 for where it comes from and 401 for its credential. Only a
 * listener bound to loopback checks `Host`.
 */
export const layer = (options: { readonly admit: Admit; readonly origins: ReadonlyArray<string> }) =>
	HttpRouter.middleware(
		Effect.gen(function* () {
			const address = (yield* HttpServer.HttpServer).address;
			const hosts =
				NetAddress.isInetAddress(address) && NetAddress.isLoopback(address.address)
					? loopback(address.port)
					: undefined;
			return (app) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					const { host, origin } = request.headers;
					if (hosts !== undefined && !hosts.includes(host?.toLowerCase() ?? ""))
						return HttpServerResponse.empty({ status: 403 });
					if (origin !== undefined && !options.origins.includes(origin))
						return HttpServerResponse.empty({ status: 403 });
					const admitted = yield* options.admit(offered(request.headers["sec-websocket-protocol"]), request);
					if (admitted === undefined) return HttpServerResponse.empty({ status: 401 });
					return yield* Effect.provideService(app, HttpServerRequest.HttpServerRequest, admitted);
				});
		}),
		{ global: true },
	);
