/* @effect-diagnostics nodeBuiltinImport:off -- stdio streams need node stream adapter for web streams. */
import * as acp from "@agentclientprotocol/sdk";
import { Control, Harness, Sandbox } from "@codeworksh/harness/effect";
import { Effect, Layer, Scope } from "effect";
import { Readable, Writable } from "node:stream";
import { Handlers } from "./handlers.ts";

export interface Options {
	readonly harness: Harness.Options;
}

// Managed instances outlive any single ACP request; the server scope is what stops them.
const managedShutdown = Layer.unwrap(
	Effect.gen(function* () {
		const control = yield* Control.Service;
		yield* Effect.addFinalizer(() =>
			Effect.gen(function* () {
				// Release drain leases before stopping managed sandboxes.
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
								Effect.logError("Failed to stop managed sandbox during ACP shutdown", cause).pipe(
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

export const makeApp = (handlers: Handlers.Interface) =>
	acp
		.agent({ name: "codework" })
		.onRequest("initialize", (ctx) => Effect.runPromise(handlers.initialize(ctx.params)))
		.onRequest("session/new", (ctx) => Effect.runPromise(handlers.newSession(ctx.params)))
		.onRequest("session/load", (ctx) => Effect.runPromise(handlers.loadSession(ctx.params, ctx.client)))
		.onRequest("session/list", (ctx) => Effect.runPromise(handlers.listSessions(ctx.params)))
		.onRequest("session/prompt", (ctx) => Effect.runPromise(handlers.prompt(ctx.params, ctx.client)))
		.onRequest("session/set_config_option", (ctx) => Effect.runPromise(handlers.setConfigOption(ctx.params)))
		.onNotification("session/cancel", (ctx) => Effect.runPromise(handlers.cancel(ctx.params).pipe(Effect.asVoid)));

/**
 * Runs the ACP agent server over stdio streams (stdin / stdout).
 */
export const serveStdio: Effect.Effect<void, never, Handlers.Service | Scope.Scope> = Effect.gen(function* () {
	const handlers = yield* Handlers.Service;
	const app = makeApp(handlers);

	const input = Writable.toWeb(process.stdout);
	const output = Readable.toWeb(process.stdin);
	const stream = acp.ndJsonStream(input, output);
	const connection = app.connect(stream);

	yield* Effect.addFinalizer(() => Effect.sync(() => connection.close()));
	yield* Effect.promise(() => connection.closed);
});

export const layer = (options: Options) =>
	Handlers.layer.pipe(Layer.provideMerge(managedShutdown), Layer.provideMerge(Harness.layer(options.harness)));

export * as Server from "./server.ts";
