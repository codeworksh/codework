/* @effect-diagnostics nodeBuiltinImport:off -- stdio streams need node stream adapter for web streams. */
import * as acp from "@agentclientprotocol/sdk";
import { Control, Harness, Sandbox, SessionStore } from "@codeworksh/harness/effect";
import { Effect, Layer, Schema, Scope } from "effect";
import { Readable, Writable } from "node:stream";
import { Handlers } from "./handlers.ts";

export interface Options {
	readonly harness: Harness.Options;
}

const isSessionNotFoundError = Schema.is(SessionStore.SessionNotFoundError);
const isPromptConflictError = Schema.is(Control.PromptConflictError);

const toRequestError = (error: unknown): acp.RequestError => {
	if (error instanceof acp.RequestError) {
		return error;
	}
	if (isSessionNotFoundError(error)) {
		return acp.RequestError.resourceNotFound(error.sessionId);
	}
	if (isPromptConflictError(error)) {
		const msg = `Prompt conflict for session ${error.sessionId}: message ${error.messageId}`;
		return acp.RequestError.invalidParams(msg, msg);
	}
	const message =
		error instanceof Error
			? error.message
			: typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
				? error.message
				: typeof error === "string"
					? error
					: "Internal error";
	return acp.RequestError.internalError(message, message);
};

const runHandler = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
	Effect.runPromise(
		effect.pipe(
			Effect.mapError(toRequestError),
			Effect.catchDefect((defect: unknown) => Effect.fail(toRequestError(defect))),
		),
	);

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
		.onRequest("initialize", (ctx) => runHandler(handlers.initialize(ctx.params)))
		.onRequest("session/new", (ctx) => runHandler(handlers.newSession(ctx.params)))
		.onRequest("session/load", (ctx) => runHandler(handlers.loadSession(ctx.params, ctx.client)))
		.onRequest("session/list", (ctx) => runHandler(handlers.listSessions(ctx.params)))
		.onRequest("session/prompt", (ctx) => runHandler(handlers.prompt(ctx.params, ctx.client)))
		.onRequest("session/set_config_option", (ctx) => runHandler(handlers.setConfigOption(ctx.params)))
		.onNotification("session/cancel", (ctx) => runHandler(handlers.cancel(ctx.params).pipe(Effect.asVoid)));

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
