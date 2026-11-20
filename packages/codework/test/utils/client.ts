import { Door } from "@codeworksh/schema";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { Headers } from "effect/http";
import { RpcMiddleware } from "effect/rpc";
import * as Client from "../../src/server/client.ts";
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
 * Both sides of the door for an in-memory server and client, which has no upgrade: a fresh token, and
 * a client that sends it on every call in the header the upgrade would have carried.
 */
export const door = Layer.unwrap(
	Effect.map(Door.make, (token) =>
		Layer.merge(
			Principal.local.pipe(Layer.provide(Layer.succeed(Principal.Token, token))),
			RpcMiddleware.layerClient(Principal.Door, ({ request, next }) =>
				next({
					...request,
					headers: Headers.set(request.headers, "sec-websocket-protocol", Door.protocols(token).join(", ")),
				}),
			),
		),
	),
);
