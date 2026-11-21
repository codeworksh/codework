import { Door, Jws, Pairing as Wire } from "@codeworksh/schema";
import { Clock, Effect, Option, Schema } from "effect";
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

const decodeGrant = Schema.decodeUnknownEffect(Wire.Grant);
const decodeRefusal = Schema.decodeUnknownEffect(Wire.Refusal);
const decodeSigned = Schema.decodeUnknownEffect(Wire.Signed);

/** This app's device key paired on the server at `url` for a pairing code, under `label`; none when the code is refused. */
export const exchange = (url: string, code: string, label: string, key: Jws.PrivateKey) =>
	HttpClientRequest.post(at(url, Wire.devicesPath)).pipe(
		HttpClientRequest.bodyJsonUnsafe({ code, label, key: Jws.publicOf(key) }),
		send,
		Effect.flatMap((response) =>
			response === undefined ? Effect.succeed(undefined) : HttpClientResponse.schemaBodyJson(Wire.Device)(response),
		),
	);

/**
 * How a server answered a ticket request: a ticket; refused by the machine it paired with (revoked or
 * lapsed); refused by it with a clock past the proof window from this computer's, which refuses every
 * proof until one is set right; or anything not signed for this request with the key it paired with.
 */
export type Answer =
	| { readonly _tag: "Ticket"; readonly ticket: string }
	| { readonly _tag: "Refused" }
	| { readonly _tag: "Clock" }
	| { readonly _tag: "Stranger" };

/** A ticket for one socket to the server at `url`, proven with `key` as `device`, signed back with `machine`'s key. */
export const ticket = Effect.fn("Pairing.ticket")(function* (
	url: string,
	device: string,
	key: Jws.PrivateKey,
	machine: Jws.PublicKey,
) {
	const nonce = yield* Door.make;
	const proof: Wire.Proof = {
		op: "ticket.create",
		aud: yield* Jws.thumbprint(machine),
		device,
		iat: yield* Clock.currentTimeMillis,
		nonce,
	};
	const jws = yield* Jws.sign(proof, key, { kid: yield* Jws.thumbprint(Jws.publicOf(key)) });
	const response = yield* HttpClient.execute(
		HttpClientRequest.post(at(url, Wire.ticketsPath)).pipe(HttpClientRequest.bodyJsonUnsafe({ jws })),
	).pipe(Effect.provide(FetchHttpClient.layer));
	const stranger: Answer = { _tag: "Stranger" };
	if (response.status !== 201 && response.status !== 401) return stranger;
	// Signed by the machine it paired with, for this proof, or by no one it knows.
	const signed = yield* response.json.pipe(
		Effect.flatMap(decodeSigned),
		Effect.flatMap(({ jws }) => Jws.verify(jws, machine)),
		Effect.option,
	);
	if (Option.isNone(signed)) return stranger;
	if (response.status === 201) {
		const grant = yield* decodeGrant(signed.value).pipe(Effect.option);
		return Option.isSome(grant) && grant.value.nonce === nonce
			? ({ _tag: "Ticket", ticket: grant.value.ticket } satisfies Answer)
			: stranger;
	}
	const refusal = yield* decodeRefusal(signed.value).pipe(Effect.option);
	if (Option.isNone(refusal) || refusal.value.nonce !== nonce) return stranger;
	return Math.abs(refusal.value.at - (yield* Clock.currentTimeMillis)) > Wire.proofWindow
		? ({ _tag: "Clock" } satisfies Answer)
		: ({ _tag: "Refused" } satisfies Answer);
});

export * as Pairing from "./pairing.ts";
