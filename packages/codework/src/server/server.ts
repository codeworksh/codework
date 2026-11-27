import { Control, Global, Harness, Sandbox, Settings } from "@codeworksh/harness/effect";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import type * as IpNetwork from "effect/net/IpNetwork";
import * as NetAddress from "effect/net/NetAddress";
import { type Rpc, type RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
/* @effect-diagnostics nodeBuiltinImport:off -- the RPC listener needs a raw node server. */
import { createServer } from "node:http";
import * as MachineFile from "../machine/file.ts";
import * as Heartbeat from "../machine/heartbeat.ts";
import * as Clones from "./clones.ts";
import * as Contract from "./contract.ts";
import * as Door from "./door.ts";
import * as EventFeed from "./feed.ts";
import * as Handlers from "./handlers.ts";
import * as Host from "./host.ts";
import * as Identity from "./identity.ts";
import * as OAuth from "./oauth.ts";
import * as Pairing from "./pairing.ts";
import * as Principal from "./principal.ts";
import * as Registration from "./registration.ts";

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

/** Ends the stored runs the last server left open, before the listener opens: a client never sees them live. */
const sweep = Layer.effectDiscard(Effect.flatMap(Control.Service, (control) => control.sweep));

/**
 * This computer is a machine from the moment its server runs: `machine.json`, with the id and identity key,
 * is made at startup rather than on the first connect or pairing, so This Machine always has an id. A file
 * it can't read or write is logged, not fatal; local work doesn't need it.
 */
const machine = Layer.effectDiscard(
	Effect.flatMap(Global.Service, (global) => MachineFile.identity(global.home)).pipe(
		Effect.provide(NodeServices.layer),
		Effect.catch((error) => Effect.logWarning("Could not set up this machine's id", error)),
	),
);

/**
 * Resumes the runs the last server left unfinished, whether it crashed or shut down, and the prompts
 * woken past a thread's head: the log and its projections record both, so this needs nothing from the
 * previous process.
 */
const resumeUnfinished = Layer.effectDiscard(
	Effect.gen(function* () {
		const control = yield* Control.Service;
		yield* Effect.forkScoped(control.resumeUnfinished);
	}),
);

/**
 * Advertises the listener once it has an address: files the registration later
 * invocations discover it through, with the token they call it with, then logs
 * the endpoint, so whoever reads that line finds the server registered.
 */
const announce = Layer.unwrap(
	Effect.gen(function* () {
		const server = yield* HttpServer.HttpServer;
		const token = yield* Principal.Token;
		const global = yield* Global.Service;
		const identity = yield* Identity.Service;
		// A ws server always binds TCP; the guard keeps the logger honest if that ever changes.
		const address = server.address;
		const url = `${NetAddress.formatUrlUnsafe(address, "ws")}${Contract.path}`;
		const listening = Layer.effectDiscard(Effect.log(`codework serve listening on ${url}`));
		if (!NetAddress.isInetAddress(address)) return listening;
		return listening.pipe(
			Layer.provide(
				Registration.register({
					home: global.home,
					info: { pid: identity.pid, version: identity.version, url, port: address.port, token },
				}),
			),
		);
	}),
);

const trusted = (given: ReadonlyArray<IpNetwork.IpNetwork> | undefined) =>
	Layer.effect(
		Pairing.TrustedProxy,
		given === undefined
			? Effect.flatMap(Settings.Service, (settings) => settings.load(undefined)).pipe(
					// Settings decode each entry, so every one parses.
					Effect.map(({ server }) => server.trustedProxy.flatMap((entry) => Settings.proxyNetwork(entry) ?? [])),
				)
			: Effect.succeed(given),
	);

/** The RPC endpoint for `group` and the pairing routes, behind the door, which turns a refused request away. */
export const endpoint = <Rpcs extends Rpc.Any>(group: RpcGroup.RpcGroup<Rpcs>) =>
	RpcServer.layer(group).pipe(
		Layer.provide(Door.protocol),
		Layer.provide(Handlers.layer.pipe(Layer.provide(EventFeed.layer))),
		Layer.provide(Door.rpc),
		Layer.merge(Pairing.routes),
		Layer.merge(Door.listener),
		Layer.provide(Door.layerConnections),
		Layer.provide(Pairing.layer),
	);

export const layer = (options: {
	host: string;
	port: number;
	harness: Harness.Options;
	/** Proxies besides loopback whose `X-Forwarded-Proto` is believed; the user settings' `server.trustedProxy` without. */
	trustedProxy?: ReadonlyArray<IpNetwork.IpNetwork>;
	/** Who the server says it is; tests name its host. */
	identity?: Layer.Layer<Identity.Service>;
}) => {
	const app = HttpRouter.serve(endpoint(Contract.Api), { disableListenLog: true }).pipe(
		Layer.provideMerge(managedShutdown),
		Layer.provideMerge(resumeUnfinished),
		Layer.provideMerge(Heartbeat.layer),
		Layer.provide(OAuth.layer(options.harness.home === undefined ? {} : { home: options.harness.home })),
		Layer.provide(Host.layer),
		Layer.provide(Clones.layer),
		Layer.provide(trusted(options.trustedProxy)),
	);
	return app.pipe(
		Layer.provideMerge(announce),
		Layer.provideMerge(NodeHttpServer.layer(createServer, { host: options.host, port: options.port })),
		Layer.provide(RpcSerialization.layerNdjson),
		Layer.provide(options.identity ?? Identity.layer),
		Layer.provide(Principal.layerToken),
		// Built after the harness and before everything above it, the listener included.
		Layer.provide(sweep),
		Layer.provide(machine),
		Layer.provide(Harness.layer(options.harness)),
	);
};
