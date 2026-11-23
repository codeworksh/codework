import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { Headers } from "effect/http";
import { RpcMiddleware } from "effect/rpc";
import * as Client from "../../src/server/client.ts";
import * as Door from "../../src/server/door.ts";
import * as Principal from "../../src/server/principal.ts";
import * as Registration from "../../src/server/registration.ts";

/** The server `home`'s service.json names, with its token. */
export const registered = (home: string) =>
	Registration.read(Registration.file(home)).pipe(
		Effect.provide(NodeServices.layer),
		Effect.flatMap((found) =>
			found === undefined ? Effect.die(`no server is registered in ${home}`) : Effect.succeed(found),
		),
	);

/** A client of the server `home`'s service.json names, sending the token filed there. */
export const connect = (home: string) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(Client.layer(yield* registered(home)));
		return yield* Client.make.pipe(Effect.provideContext(context));
	});

/**
 * Both sides of the door for an in-memory server and client, which has no upgrade: one local
 * connection, and a client that sends its key on every call in the header the door would have added.
 */
export const door = Layer.unwrap(
	Effect.gen(function* () {
		const key = yield* (yield* Door.Connections).open({ kind: "local" });
		return Layer.merge(
			Door.rpc,
			RpcMiddleware.layerClient(Principal.Door, ({ request, next }) =>
				next({ ...request, headers: Headers.set(request.headers, Door.header, key) }),
			),
		);
	}),
).pipe(Layer.provideMerge(Door.layerConnections));
