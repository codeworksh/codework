import { Global } from "@codeworksh/harness/effect";
import { Door as Knock } from "@codeworksh/schema";
import { NodeServices } from "@effect/platform-node";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import { RpcMiddleware } from "effect/rpc";

/** Who is calling, decided once per connection by the listener's door. */
export type Principal =
	/** Holds the home's token, from this computer: nothing stored about who. */
	| { readonly kind: "local" }
	/** A paired device, by the id `codework service devices` lists. */
	| { readonly kind: "device"; readonly id: string };

export class Current extends Context.Service<Current, Principal>()("@codeworksh/cli/server/principal/Current") {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Server.Unauthorized", {
	message: Schema.String,
}) {}

/** A call this caller may not make: only this computer manages who is paired, and only a device leaves. */
export class Forbidden extends Schema.TaggedError<Forbidden>()("Server.Forbidden", {
	message: Schema.String,
}) {}

/**
 * Decides the caller of every RPC from the connection it comes on. The contract carries the tag; each
 * listener provides its own implementation where it is built.
 */
export class Door extends RpcMiddleware.Service<Door, { provides: Current }>()(
	"@codeworksh/cli/server/principal/Door",
	{ error: Unauthorized },
) {}

/** `effect`, for a local caller only; a device is refused. */
export const local = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		if ((yield* Current).kind !== "local")
			return yield* new Forbidden({ message: "Only this computer manages its paired devices" });
		return yield* effect;
	});

/** The home's token for the life of the server, which every local client sends. */
export class Token extends Context.Service<Token, string>()("@codeworksh/cli/server/principal/Token") {}

/**
 * A fresh token per start, published in `service.json` alone. A `<home>/token` an earlier build kept
 * is deleted, so no stale copy of a credential stays behind.
 */
export const layerToken = Layer.effect(
	Token,
	Effect.gen(function* () {
		const global = yield* Global.Service;
		const fs = yield* FileSystem.FileSystem;
		yield* fs.remove(`${global.home}/token`).pipe(Effect.ignore);
		return yield* Knock.make;
	}).pipe(Effect.provide(NodeServices.layer)),
);
