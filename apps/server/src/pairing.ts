import { Pairing as Wire } from "@codeworksh/schema";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

/** A remote server's pairing route `path`, beside its socket: the HTTP origin of its WebSocket URL. */
const at = (url: string, path: string) => {
	const { protocol, host } = new URL(url);
	return `${protocol === "wss:" ? "https:" : "http:"}//${host}${path}`;
};

/** `request`'s answer when 200; none for a refused credential (401); any other answer fails. */
const send = (request: HttpClientRequest.HttpClientRequest) =>
	HttpClient.execute(request).pipe(
		Effect.flatMap((response) =>
			response.status === 401 ? Effect.succeed(undefined) : HttpClientResponse.filterStatusOk(response),
		),
		Effect.provide(FetchHttpClient.layer),
	);

/** A session on the server at `url` for a pairing code, under `label`; none when the code is refused. */
export const exchange = (url: string, code: string, label: string) =>
	HttpClientRequest.post(at(url, Wire.pairPath)).pipe(
		HttpClientRequest.bodyJsonUnsafe({ code, label }),
		send,
		Effect.flatMap((response) =>
			response === undefined ? Effect.succeed(undefined) : HttpClientResponse.schemaBodyJson(Wire.Device)(response),
		),
	);

/** A ticket for one socket to the server at `url`; none once it refuses the session (revoked or lapsed). */
export const ticket = (url: string, session: string) =>
	HttpClientRequest.post(at(url, Wire.ticketPath)).pipe(
		HttpClientRequest.bearerToken(session),
		send,
		Effect.flatMap((response) =>
			response === undefined
				? Effect.succeed(undefined)
				: Effect.map(HttpClientResponse.schemaBodyJson(Wire.Ticket)(response), (body) => body.ticket),
		),
	);

export * as Pairing from "./pairing.ts";
