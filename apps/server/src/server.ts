import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { Config, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
/* @effect-diagnostics nodeBuiltinImport:off -- the RPC listener needs a raw node server. */
import { createServer } from "node:http";
import { Codework } from "./codework.ts";
import { Contract } from "./contract.ts";
import { Db } from "./db.ts";
import { Event } from "./event.ts";
import { Handlers } from "./handlers.ts";
import { Kv } from "./kv.ts";
import { Widgets } from "./widgets.ts";

// The port is chosen by the OS, so the supervisor learns it from this line.
const announceReady = Layer.effectDiscard(
	Effect.gen(function* () {
		const server = yield* HttpServer.HttpServer;
		if (server.address._tag === "UnixPathAddress") return;
		const port = server.address.port;
		yield* Effect.sync(() => process.stdout.write(`${JSON.stringify({ type: "ready", port })}\n`));
	}),
);

// Electron main sets the path to a file in its userData folder.
const database = Layer.unwrap(Effect.map(Config.String("CODEWORK_DATABASE"), Db.layer)).pipe(Layer.orDie);

const rpc = RpcServer.layerHttp({ group: Contract.Api, path: "/rpc", protocol: "websocket" }).pipe(
	Layer.provide(Handlers.layer),
);

// One event log, kv and CodeWork connection for the RPC handlers and the widget backends alike.
export const layer = Layer.mergeAll(HttpRouter.serve(rpc, { disableListenLog: true }), Widgets.layer).pipe(
	Layer.provide(Layer.mergeAll(Event.layer, Kv.layer, Codework.layer)),
	Layer.provideMerge(announceReady),
	Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
	Layer.provide(RpcSerialization.layerNdjson),
	Layer.provide(database),
	Layer.provide(NodeServices.layer),
);

export * as Server from "./server.ts";
