import { Effect, Layer } from "effect";
import * as Client from "./client.ts";

/**
 * One `server.info` call, with the answer normalized to `undefined` for every
 * way a server can fail to answer: unreachable, slow, refusing the token, or
 * speaking a different protocol. A health check that throws where it should say
 * "no" would make every caller wrap it in a catch.
 */
export const probe = (server: Client.Target) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(Client.layer(server)).pipe(Effect.orElseSucceed(() => undefined));
		if (context === undefined) return undefined;
		return yield* Effect.gen(function* () {
			const rpc = yield* Client.make;
			return yield* rpc["server.info"]({}).pipe(Effect.timeout("1 second"));
		}).pipe(
			Effect.provideContext(context),
			Effect.orElseSucceed(() => undefined),
		);
	}).pipe(Effect.scoped);
