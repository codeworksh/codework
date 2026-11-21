import { Schema } from "effect";
import { PublicKey } from "./jws.ts";

// How another computer pairs with a CodeWork server over plain HTTP, beside its socket. As with SSH,
// each side holds a key and keeps the other's public half; only signatures cross the wire. A refused
// credential gets 401, never why.

/** `POST` with {@link Exchange} creates a device: answers 201 with {@link Device}. */
export const devicesPath = "/api/v1/devices";
/**
 * `POST` with a {@link Signed} {@link Proof} creates a ticket: answers 201 with a {@link Signed} {@link Grant},
 * or 401 with a {@link Signed} {@link Refusal} (empty when the body names no nonce).
 */
export const ticketsPath = "/api/v1/tickets";

/** What `POST /api/v1/devices` takes: the code a person read, a name for the computer offering it, and its key. */
export const Exchange = Schema.Struct({
	code: Schema.String,
	label: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100), Schema.isPattern(/^[^\p{Cc}]*$/u)),
	key: PublicKey,
});

/** A new device: its id, and the machine's identity key, which signs every {@link Grant}. */
export const Device = Schema.Struct({ id: Schema.String, machine: PublicKey });

/** A compact JWS, as both ticket routes carry one. */
export const Signed = Schema.Struct({ jws: Schema.String });

/** How long a {@link Proof} is good for, either side of the machine's clock; its nonce is held as long. */
export const proofWindow = 5 * 60 * 1000;

/** A device asking for a ticket, signed with its key and named by the key's thumbprint; each nonce is taken once. */
export const Proof = Schema.Struct({
	op: Schema.Literal("ticket.create"),
	/** The thumbprint of the machine key it is for: one device key is paired with every machine. */
	aud: Schema.String,
	device: Schema.String,
	/** Epoch milliseconds. */
	iat: Schema.Finite,
	nonce: Schema.String,
});
export type Proof = typeof Proof.Type;

/** A ticket for one socket, signed with the machine's identity key, echoing the {@link Proof}'s nonce. */
export const Grant = Schema.Struct({
	op: Schema.Literal("ticket.grant"),
	ticket: Schema.String,
	nonce: Schema.String,
});
export type Grant = typeof Grant.Type;

/**
 * A refused {@link Proof}, signed with the machine's identity key, echoing the nonce it named, so a refusal
 * is told from another machine's. `at` is the machine's clock, epoch milliseconds. It never says why.
 */
export const Refusal = Schema.Struct({
	op: Schema.Literal("ticket.refuse"),
	nonce: Schema.String,
	at: Schema.Finite,
});
export type Refusal = typeof Refusal.Type;
