/* @effect-diagnostics nodeBuiltinImport:off -- the Node entry serves the relay locally. */
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Config, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { createServer } from "node:http";
import * as Db from "./db.ts";
import { routes } from "./http.ts";

// The relay on Node, for development and the E2E suite: migrates, then serves on HOST and PORT (0 picks
// a free port) and logs the address it bound. HOST=0.0.0.0 lets machines on other hosts reach it.
// Without DATABASE_URL it uses compose.yaml's Postgres, which `pnpm db` starts.
process.env.DATABASE_URL ??= "postgres://relay:relay@127.0.0.1:55432/relay";

const server = Layer.unwrap(
	Effect.gen(function* () {
		const host = yield* Config.String("HOST").pipe(Config.withDefault("127.0.0.1"));
		// Int, not Port: Port rejects 0.
		const port = yield* Config.Int("PORT").pipe(Config.withDefault(8787));
		return NodeHttpServer.layer(createServer, { host, port });
	}),
);

const app = HttpRouter.serve(routes).pipe(
	Layer.provide(server),
	Layer.provide(Layer.effectDiscard(Db.migrate).pipe(Layer.provideMerge(Db.layer))),
);

Layer.launch(app).pipe(NodeRuntime.runMain);
