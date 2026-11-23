import { Schema } from "effect";
import { Connected } from "./relay.ts";

// A CodeWork server as a machine: what its clients (the desktop app) see over the CodeWork RPC.

/** This machine and the workspaces it is connected to, from its `machine.json`. */
export const Status = Schema.Struct({
	/** None before the machine's first connect gives it an identity. */
	id: Schema.NullOr(Schema.String),
	/** The OS's name for the host, read fresh. */
	localHostName: Schema.String,
	/** The user's own name for it, shown in place of `localHostName` when set. */
	givenName: Schema.NullOr(Schema.String),
	/**
	 * Each link with the thumbprint of its key: a relay row under another key is not this machine's. A
	 * leaving link was ended here while the relay couldn't be reached; it is revoked once it can. Older
	 * machines don't report it.
	 */
	workspaces: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			keyId: Schema.String,
			leaving: Schema.optionalKey(Schema.Boolean),
		}),
	),
});
export type Status = typeof Status.Type;

export const Disconnect = Schema.Struct({ workspaceId: Schema.String, keyId: Schema.String });

/** A disconnect: this machine afterwards, and whether the relay confirmed; if not, the link is left leaving. */
export const Disconnected = Schema.Struct({ status: Status, revoked: Schema.Boolean });
export type Disconnected = typeof Disconnected.Type;

/** A connect's progress: the code to approve, then the link once a member approved it. */
export const ConnectEvent = Schema.Union([
	Schema.TaggedStruct("Code", { userCode: Schema.String }),
	Schema.TaggedStruct("Connected", { connected: Connected }),
]);
export type ConnectEvent = typeof ConnectEvent.Type;

export class ConnectError extends Schema.TaggedError<ConnectError>()("Machine.ConnectError", {
	message: Schema.String,
}) {}
