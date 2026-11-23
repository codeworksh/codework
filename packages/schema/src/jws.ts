import { Effect, Result, Schema } from "effect";
import { Base64Url } from "effect/encoding";

// Compact JWS with Ed25519 (EdDSA) over WebCrypto, so the same code signs on a machine (Node) and
// verifies in the relay (Node or a Worker).

export const PublicKey = Schema.Struct({
	kty: Schema.Literal("OKP"),
	crv: Schema.Literal("Ed25519"),
	x: Schema.String,
});
export type PublicKey = typeof PublicKey.Type;

export const PrivateKey = Schema.Struct({ ...PublicKey.fields, d: Schema.String });
export type PrivateKey = typeof PrivateKey.Type;

export const Header = Schema.Struct({
	alg: Schema.Literal("EdDSA"),
	/** The signing key's thumbprint, for a key the verifier already holds. */
	kid: Schema.optional(Schema.String),
	/** The signing key itself, for a request that registers it. */
	jwk: Schema.optional(PublicKey),
});
export type Header = typeof Header.Type;

export class JwsError extends Schema.TaggedError<JwsError>()("Jws.JwsError", {
	reason: Schema.Literals(["malformed", "signature", "crypto"]),
}) {}

const algorithm = { name: "Ed25519" } as const;
const decodeHeader = Schema.decodeUnknownEffect(Schema.fromJsonString(Header));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const crypto = <A>(evaluate: () => Promise<A>) =>
	Effect.tryPromise({ try: evaluate, catch: () => new JwsError({ reason: "crypto" }) });
const bytes = (part: string) =>
	Result.match(Base64Url.decode(part), {
		onFailure: () => Effect.fail(new JwsError({ reason: "malformed" })),
		onSuccess: (decoded) => Effect.succeed(Uint8Array.from(decoded)),
	});

/** The public half of a private key. */
export const publicOf = (key: PrivateKey): PublicKey => ({ kty: key.kty, crv: key.crv, x: key.x });

/** A fresh Ed25519 keypair as a private JWK; its public half is {@link publicOf}. */
export const generate = Effect.fn("Jws.generate")(function* () {
	const pair = yield* crypto(() => globalThis.crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]));
	if (!("privateKey" in pair)) return yield* new JwsError({ reason: "crypto" });
	const jwk = yield* crypto(() => globalThis.crypto.subtle.exportKey("jwk", pair.privateKey));
	return yield* Schema.decodeUnknownEffect(PrivateKey)(jwk).pipe(
		Effect.mapError(() => new JwsError({ reason: "crypto" })),
	);
});

/** The RFC 7638 thumbprint of a public key: base64url SHA-256 of its required members, in order. */
export const thumbprint = Effect.fn("Jws.thumbprint")(function* (key: PublicKey) {
	const canonical = `{"crv":"${key.crv}","kty":"${key.kty}","x":"${key.x}"}`;
	const digest = yield* crypto(() => globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
	return Base64Url.encode(new Uint8Array(digest));
});

/** A key's thumbprint as people compare it, `SHA256:<thumbprint>`. */
export const fingerprintOf = (thumbprint: string) => `SHA256:${thumbprint}`;

/** A public key as people compare it: {@link fingerprintOf} its thumbprint. */
export const fingerprint = (key: PublicKey) => Effect.map(thumbprint(key), fingerprintOf);

/** Signs `claims` with `key`, naming it by `kid` or embedding its public half. */
export const sign = Effect.fn("Jws.sign")(function* (
	claims: unknown,
	key: PrivateKey,
	name: { readonly kid: string } | { readonly embed: true },
) {
	const header: Header = "kid" in name ? { alg: "EdDSA", kid: name.kid } : { alg: "EdDSA", jwk: publicOf(key) };
	const input = `${Base64Url.encode(JSON.stringify(header))}.${Base64Url.encode(JSON.stringify(claims))}`;
	const signer = yield* crypto(() => globalThis.crypto.subtle.importKey("jwk", key, algorithm, false, ["sign"]));
	const signature = yield* crypto(() =>
		globalThis.crypto.subtle.sign(algorithm, signer, new TextEncoder().encode(input)),
	);
	return `${input}.${Base64Url.encode(new Uint8Array(signature))}`;
});

const parts = (token: string) => {
	const [header, claims, signature, extra] = token.split(".");
	return header === undefined || claims === undefined || signature === undefined || extra !== undefined
		? Effect.fail(new JwsError({ reason: "malformed" }))
		: Effect.succeed({ header, claims, signature });
};

const decodeClaims = (part: string) =>
	Effect.flatMap(bytes(part), (decoded) =>
		decodeJson(new TextDecoder().decode(decoded)).pipe(Effect.mapError(() => new JwsError({ reason: "malformed" }))),
	);

/** A token's header, read before its signature is checked, to find the key that checks it. */
export const peek = Effect.fn("Jws.peek")(function* (token: string) {
	const { header } = yield* parts(token);
	return yield* decodeHeader(new TextDecoder().decode(yield* bytes(header))).pipe(
		Effect.mapError(() => new JwsError({ reason: "malformed" })),
	);
});

/** A token's claims, still undecoded, read without checking its signature: for echoing, never for trusting. */
export const peekClaims = Effect.fn("Jws.peekClaims")(function* (token: string) {
	return yield* decodeClaims((yield* parts(token)).claims);
});

/** Checks `token`'s signature against `key` and returns its claims, still undecoded. */
export const verify = Effect.fn("Jws.verify")(function* (token: string, key: PublicKey) {
	const { header, claims, signature } = yield* parts(token);
	const signed = yield* bytes(signature);
	const verifier = yield* crypto(() => globalThis.crypto.subtle.importKey("jwk", key, algorithm, false, ["verify"]));
	const valid = yield* crypto(() =>
		globalThis.crypto.subtle.verify(algorithm, verifier, signed, new TextEncoder().encode(`${header}.${claims}`)),
	);
	if (!valid) return yield* new JwsError({ reason: "signature" });
	return yield* decodeClaims(claims);
});
