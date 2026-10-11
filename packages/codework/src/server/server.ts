import { Control, Global, Harness, Sandbox } from "@codeworksh/harness/effect";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import { RpcSerialization, RpcServer } from "effect/rpc";
/* @effect-diagnostics nodeBuiltinImport:off -- the RPC listener needs a raw node server. */
import { createServer } from "node:http";
import { Contract } from "./contract.ts";
import { EventFeed } from "./feed.ts";
import { Handlers } from "./handlers.ts";
import { Identity } from "./identity.ts";
import { OAuth } from "./oauth.ts";
import { Registration } from "./registration.ts";

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

/**
 * Advertises the listener once it has an address: logs the endpoint and files
 * the registration later invocations discover it through.
 */
const announce = Layer.unwrap(
	Effect.gen(function* () {
		const server = yield* HttpServer.HttpServer;
		const global = yield* Global.Service;
		const identity = yield* Identity.Service;
		// A ws server always binds TCP; the guard keeps the logger honest if that ever changes.
		const address = server.address;
		const url = `${NetAddress.formatUrlUnsafe(address, "ws")}${Contract.path}`;
		yield* Effect.log(`codework serve listening on ${url}`);
		if (!NetAddress.isInetAddress(address)) return Layer.empty;
		return Registration.register({
			home: global.home,
			info: { pid: identity.pid, version: identity.version, url, port: address.port },
		});
	}),
);

export const layer = (options: { host: string; port: number; harness: Harness.Options }) => {
	const rpc = RpcServer.layerHttp({ group: Contract.Api, path: Contract.path, protocol: "websocket" }).pipe(
		Layer.provide(Handlers.layer.pipe(Layer.provide(EventFeed.layer))),
	);
	const app = HttpRouter.serve(rpc, { disableListenLog: true }).pipe(
		Layer.provideMerge(managedShutdown),
		Layer.provide(OAuth.layer(options.harness.home === undefined ? {} : { home: options.harness.home })),
	);
	return app.pipe(
		Layer.provideMerge(announce),
		Layer.provideMerge(NodeHttpServer.layer(createServer, { host: options.host, port: options.port })),
		Layer.provide(RpcSerialization.layerNdjson),
		Layer.provide(Identity.layer),
		Layer.provide(Harness.layer(options.harness)),
	);
};

export * as Server from "./server.ts";
