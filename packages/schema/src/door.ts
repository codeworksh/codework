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

interface Listener {
	/** The `Host` values it answers: its loopback names with its port; none when bound beyond loopback. */
	readonly hosts: ReadonlyArray<string> | undefined;
	/** The browser origins it serves; a request from any other is refused. */
	readonly origins: ReadonlyArray<string>;
	readonly token: string;
}

/** What a listener reads off a request before letting it in. */
interface Knock {
	readonly host: string | undefined;
	readonly origin: string | undefined;
	readonly protocol: string | undefined;
}

/** The names a loopback listener on `port` answers to. */
const loopback = (port: number) => ["127.0.0.1", "localhost", "[::1]"].map((name) => `${name}:${port}`);

/** The status a request is turned away with: 403 for where it comes from, 401 for its token; none lets it in. */
const verdict = (listener: Listener, knock: Knock): 401 | 403 | undefined => {
	if (listener.hosts !== undefined && !listener.hosts.includes(knock.host?.toLowerCase() ?? "")) return 403;
	if (knock.origin !== undefined && !listener.origins.includes(knock.origin)) return 403;
	const token = offered(knock.protocol);
	return token !== undefined && matches(token, listener.token) ? undefined : 401;
};

/**
 * The door on every request the listener serves, before a WebSocket upgrade: a refused one gets a
 * plain HTTP status instead of 101. Only a listener bound to loopback checks `Host`.
 */
export const layer = (options: { readonly token: string; readonly origins: ReadonlyArray<string> }) =>
	HttpRouter.middleware(
		Effect.gen(function* () {
			const address = (yield* HttpServer.HttpServer).address;
			const listener: Listener = {
				...options,
				hosts:
					NetAddress.isInetAddress(address) && NetAddress.isLoopback(address.address)
						? loopback(address.port)
						: undefined,
			};
			return (app) =>
				Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
					const status = verdict(listener, {
						host: request.headers.host,
						origin: request.headers.origin,
						protocol: request.headers["sec-websocket-protocol"],
					});
					return status === undefined ? app : Effect.succeed(HttpServerResponse.empty({ status }));
				});
		}),
		{ global: true },
	);
