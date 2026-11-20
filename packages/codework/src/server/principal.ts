import { Global } from "@codeworksh/harness/effect";
import { Door as Knock } from "@codeworksh/schema";
import { NodeServices } from "@effect/platform-node";
import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { Headers } from "effect/http";
import { RpcMiddleware } from "effect/rpc";

/** Who is calling, decided once per request by the listener's {@link Door}. */
export type Principal = {
	/** Holds the home's token: at this computer; nothing stored about who. */
	readonly kind: "local";
};

export class Current extends Context.Service<Current, Principal>()("@codeworksh/cli/server/principal/Current") {}

class Unauthorized extends Schema.TaggedError<Unauthorized>()("Server.Unauthorized", {
	message: Schema.String,
}) {}

/** The refusal of a caller that brought no token: every CodeWork server takes its home's. */
const missing = () => new Unauthorized({ message: "This CodeWork server requires its home's token" });

/**
 * Decides the caller of every RPC from the credential its connection opened with. The contract
 * carries the tag; each listener provides its own implementation where it is built.
 */
export class Door extends RpcMiddleware.Service<Door, { provides: Current }>()(
	"@codeworksh/cli/server/principal/Door",
	{ error: Unauthorized },
) {}

/** The home's token, which every client of its server sends. */
export class Token extends Context.Service<Token, string>()("@codeworksh/cli/server/principal/Token") {}

/** `<home>/token`: deleting it and restarting the server is how a person replaces the token. */
export const file = (home: string) => `${home}/token`;

/** The token in `home`, made on first use. */
const ensure = Effect.fn("Principal.ensure")(function* (home: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = file(home);
	if (!(yield* fs.exists(path))) {
		yield* fs.makeDirectory(home, { recursive: true });
		const temp = `${path}.${process.pid}.tmp`;
		yield* fs.writeFileString(temp, yield* Knock.make, { mode: 0o600 });
		// A link never replaces a file, so of two servers starting in a fresh home, one token wins.
		yield* fs.link(temp, path).pipe(Effect.ignore, Effect.ensuring(fs.remove(temp).pipe(Effect.ignore)));
	}
	const token = (yield* fs.readFileString(path)).trim();
	if (!Knock.isToken(token)) return yield* Effect.die(`${path} holds no token; delete it to make a new one`);
	return token;
});

/** The home's token, from `<home>/token`. */
export const layerToken = Layer.effect(
	Token,
	Effect.flatMap(Global.Service, (global) => ensure(global.home)).pipe(
		Effect.provide(NodeServices.layer),
		Effect.orDie,
	),
);

/** The listener's door before any upgrade: no browser origin is served. */
export const listener = Layer.unwrap(Effect.map(Token, (token) => Knock.layer({ token, origins: [] })));

/**
 * The listener's door on every call: only a connection that opened with the home's token gets in,
 * as `local`. The upgrade request's headers come with every call, so the token is read where the
 * listener checked it, and is still required where nothing did.
 */
export const local = Layer.effect(
	Door,
	Effect.map(Token, (token) =>
		Door.of((effect, { headers }) => {
			const given = Knock.offered(Option.getOrUndefined(Headers.get(headers, "sec-websocket-protocol")));
			if (given === undefined) return Effect.fail(missing());
			return Knock.matches(given, token)
				? Effect.provideService(effect, Current, { kind: "local" })
				: Effect.fail(new Unauthorized({ message: "The CodeWork token does not match this server" }));
		}),
	),
);
