import { Control, Harness, Sandbox } from "@codeworksh/harness/effect";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
/* @effect-diagnostics nodeBuiltinImport:off -- the RPC listener needs a raw node server. */
import { createServer } from "node:http";
import { Contract } from "./contract.ts";
import { EventFeed } from "./feed.ts";
import { Handlers } from "./handlers.ts";

const WsProtocol = RpcServer.layerProtocolWebsocket({ path: "/rpc" }).pipe(Layer.provide(HttpRouter.layer));

// Managed instances outlive any single RPC; the serve scope is what stops them.
const managedShutdown = Layer.unwrap(
	Effect.gen(function* () {
		const control = yield* Control.Service;
		yield* Effect.addFinalizer(() =>
			Effect.gen(function* () {
				// Release drain leases before stopping the server's managed sandboxes.
				// Both phases are best effort and bounded so a provider cannot prevent
				// process shutdown; an interrupted stop is persisted as faulted and can
				// recover the next time that sandbox is mounted.
				yield* Effect.forEach(
					yield* control.active,
					(id) =>
						control
							.interrupt(id, { reason: "shutdown", awaitSettlement: true })
							.pipe(Effect.timeout("10 seconds"), Effect.ignore),
					{ concurrency: "unbounded", discard: true },
				);
				const infos = yield* Sandbox.list();
				yield* Effect.forEach(
					infos.filter((info) => info.ownership === "managed"),
					(info) =>
						Sandbox.stop(info.id).pipe(
							Effect.timeout("10 seconds"),
							Effect.catchCause((cause) =>
								Effect.logError("Failed to stop managed sandbox during shutdown", cause).pipe(
									Effect.annotateLogs({ sandboxInstanceId: info.id }),
								),
							),
						),
					{ concurrency: "unbounded", discard: true },
				);
			}),
		);
		return Layer.empty;
	}),
);

const listenLog = Layer.unwrap(
	Effect.gen(function* () {
		const server = yield* HttpServer.HttpServer;
		yield* Effect.log(`codework serve listening on ${NetAddress.formatUrlUnsafe(server.address, "ws")}/rpc`);
		return Layer.empty;
	}),
);

export const layer = (options: { host: string; port: number; harness: Harness.Options }) => {
	const rpc = RpcServer.layer(Contract.Api).pipe(Layer.provide(Handlers.layer.pipe(Layer.provide(EventFeed.layer))));
	const app = rpc.pipe(
		Layer.provideMerge(WsProtocol),
		Layer.provide(HttpRouter.serve(WsProtocol, { disableListenLog: true })),
		Layer.provideMerge(managedShutdown),
	);
	return app.pipe(
		Layer.provideMerge(listenLog),
		Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { host: options.host, port: options.port })),
		Layer.provide(RpcSerialization.layerNdjson),
		Layer.provide(Harness.layer(options.harness)),
	);
};

export * as Server from "./server.ts";
