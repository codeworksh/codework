import { Option, Result } from "effect";
import type { HttpServerRequest } from "effect/http";
import * as IpNetwork from "effect/net/IpNetwork";
import * as NetAddress from "effect/net/NetAddress";

// A listener speaks plain HTTP; TLS ends at a proxy in front of it, which says so in
// `X-Forwarded-Proto`. Any client can send that header, so only a proxy's is believed: a peer on
// loopback, or in the trusted list.

/** The address `request` came from, by its socket, canonical; none when it has none. */
export const peer = (request: HttpServerRequest.HttpServerRequest): NetAddress.IpAddress | undefined =>
	Option.match(request.remoteAddress, {
		onNone: () => undefined,
		onSome: (address) =>
			Result.getOrUndefined(Result.map(NetAddress.ipFromString(address), (ip) => NetAddress.toCanonical(ip))),
	});

/** Whether `request` reached the proxy in front of this listener over TLS, by a proxy on loopback or in `trusted`. */
export const encrypted = (
	request: HttpServerRequest.HttpServerRequest,
	trusted: ReadonlyArray<IpNetwork.IpNetwork>,
): boolean => {
	const from = peer(request);
	if (
		from === undefined ||
		!(NetAddress.isLoopback(from) || trusted.some((network) => IpNetwork.contains(network, from)))
	)
		return false;
	// A chain of proxies appends; the first is the one the client reached.
	return request.headers["x-forwarded-proto"]?.split(",")[0]?.trim().toLowerCase() === "https";
};
