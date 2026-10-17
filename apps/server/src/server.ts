import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { Config, Effect, Layer, Schedule } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
/* @effect-diagnostics nodeBuiltinImport:off -- the RPC listener needs a raw node server. */
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { Codework } from "./codework.ts";
import { Contract } from "./contract.ts";
import { Db } from "./db.ts";
import { Event } from "./event.ts";
import { Handlers } from "./handlers.ts";
import { Kv } from "./kv.ts";
import { Servers } from "./servers.ts";
import { Widgets } from "./widgets.ts";

/**
 * The RPC listener. Closing a Node server waits for every connection to end, and the app's page keeps
 * its WebSocket open, so closing also ends the connections left: on shutdown nobody needs them.
 */
const listener = () => {
	const server = createServer();
	const sockets = new Set<Socket>();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	const close = server.close.bind(server);
	server.close = (callback) => {
		for (const socket of sockets) socket.destroy();
		return close(callback);
	};
	return server;
};

// The port is chosen by the OS, so the supervisor learns it from this line.
const announceReady = Layer.effectDiscard(
	Effect.gen(function* () {
		const server = yield* HttpServer.HttpServer;
		if (server.address._tag === "UnixPathAddress") return;
		const port = server.address.port;
		yield* Effect.sync(() => process.stdout.write(`${JSON.stringify({ type: "ready", port })}\n`));
	}),
);

/**
 * Stops this process once the one that started it is gone: Electron killed outright, or crashed, cannot
 * stop it, and an app server nobody can reach would only hold the database. It stops as on SIGTERM.
 */
const exitWithParent = Layer.effectDiscard(
	Effect.gen(function* () {
		const parent = process.ppid;
		yield* Effect.sync(() => process.ppid).pipe(
			Effect.repeat({ while: (ppid) => ppid === parent, schedule: Schedule.spaced("1 second") }),
			Effect.andThen(Effect.sync(() => process.kill(process.pid, "SIGTERM"))),
			Effect.forkScoped,
		);
	}),
);

// Electron main sets the path to a file in its userData folder.
const database = Layer.unwrap(Effect.map(Config.String("CODEWORK_DATABASE"), Db.layer)).pipe(Layer.orDie);

const rpc = RpcServer.layerHttp({ group: Contract.Api, path: "/rpc", protocol: "websocket" }).pipe(
	Layer.provide(Handlers.layer),
);

// One event log, kv and CodeWork connection for the RPC handlers and the widget backends alike.
export const layer = Layer.mergeAll(
	HttpRouter.serve(rpc, { disableListenLog: true }),
	Widgets.layer,
	exitWithParent,
).pipe(
	Layer.provide(Layer.mergeAll(Event.layer, Kv.layer, Codework.layer)),
	// The app's servers decide which one its connection goes to, and the handlers manage them too.
	Layer.provideMerge(Servers.layer),
	Layer.provideMerge(announceReady),
	Layer.provideMerge(NodeHttpServer.layer(listener, { host: "127.0.0.1", port: 0 })),
	Layer.provide(RpcSerialization.layerNdjson),
	Layer.provide(database),
	Layer.provide(NodeServices.layer),
);

export * as Server from "./server.ts";
