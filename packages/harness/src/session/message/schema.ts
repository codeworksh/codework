import { Schema } from "effect";
import { uuidv7 } from "uuidv7";
import { withStatics } from "../../schema.ts";

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
export const ID = Schema.String.pipe(
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
export type ID = typeof ID.Type;

export * as SessionMessageSchema from "./schema.ts";
