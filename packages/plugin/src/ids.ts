import { Schema } from "effect";
import { uuidv7 } from "uuidv7";
import { withStatics } from "./schema.ts";

/**
 * The identifiers that cross the plugin boundary.
 *
 * A plugin reads a session id off its context and a message id off every tool call, so both
 * brands have to be the ones the harness itself mints -- a structurally identical brand declared
 * twice is two types, and a plugin would have to cast to hand either back. They live here, in the
 * package both sides depend on, rather than being re-declared on each side.
 */

// Session identity. Branded so a session ID is not interchangeable with an
// entry, part, or workspace ID at the type level — service signatures take
// `SessionID`, never a bare `string`.
//
// `create` mints a new one; `ascending` adopts an ID that came from outside
// (a persisted row, a request payload) and rejects a foreign prefix rather
// than branding it silently. uuidv7 keeps IDs lexicographically sortable by
// creation time, so `ORDER BY id` is `ORDER BY created`.
export const SessionID = Schema.String.check(Schema.isStartsWith("ses")).pipe(
	Schema.brand("Session.ID"),
	withStatics((schema) => ({
		ascending: (id?: string) => {
			if (!id) return schema.make("ses_" + uuidv7());
			if (!id.startsWith("ses")) throw new Error(`ID ${id} does not start with ses`);
			return schema.make(id);
		},
		create: () => schema.make("ses_" + uuidv7()),
	})),
);
export type SessionID = typeof SessionID.Type;

/**
 * A conversation message id.
 *
 * Deliberately unprefixed. aikit mints assistant message ids itself, as bare
 * uuidv7, and `stream()` accepts no id -- so any naming rule of ours would have
 * to be imposed on messages aikit hands us, by rewriting a field of the value we
 * were given. Sharing aikit's format instead means an id means the same thing on
 * both sides of the boundary and never needs translating.
 *
 * The brand carries the meaning; uuidv7 keeps ids time-ordered, so they sort by
 * creation.
 */
export const MessageID = Schema.String.pipe(
	Schema.brand("Message.ID"),
	withStatics((schema) => ({
		create: () => schema.make(uuidv7()),
		/**
		 * Adopt an id minted elsewhere -- in practice aikit's, which arrives as a
		 * plain string on every stream event and inside every assistant message.
		 *
		 * `make` does the same thing. This exists so the boundary where a foreign
		 * id enters the domain is named and greppable, and so the pairing with
		 * `create` says which side chose the id.
		 */
		from: (id: string) => schema.make(id),
	})),
);
export type MessageID = typeof MessageID.Type;
