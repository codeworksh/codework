import { Schema } from "effect";

// How another computer pairs with a CodeWork server over plain HTTP, beside its socket. A refused
// credential gets 401, never why.

/** `POST` with {@link Exchange} creates a device: answers 201 with {@link Device}. */
export const devicesPath = "/api/v1/devices";
/** `POST` with `Authorization: Bearer <session token>` creates a ticket: answers 201 with {@link Ticket}. */
export const ticketsPath = "/api/v1/tickets";

/** What `POST /api/v1/devices` takes: the code a person read, and a name for the computer offering it. */
export const Exchange = Schema.Struct({
	code: Schema.String,
	label: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100), Schema.isPattern(/^[^\p{Cc}]*$/u)),
});

/** A new device: its id, and the session token only it holds. */
export const Device = Schema.Struct({ id: Schema.String, token: Schema.String });

/** A single-use credential for one socket, offered where a local client offers the home's token. */
export const Ticket = Schema.Struct({ ticket: Schema.String });
