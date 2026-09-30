import * as Acp from "@agentclientprotocol/sdk";
import { Cause, Deferred, Effect, Exit, Option, Schema, type Scope, type Stdio, Stream } from "effect";

/** A JSON-RPC error a handler answers a request with. */
export class RequestError extends Schema.TaggedError<RequestError>()("AcpRequestError", {
	code: Schema.Int,
	message: Schema.String,
}) {
	static invalidRequest = (message: string) => new RequestError({ code: -32600, message });
	static invalidParams = (message: string) => new RequestError({ code: -32602, message });
	static internalError = (message: string) => new RequestError({ code: -32603, message });
	static resourceNotFound = (message: string) => new RequestError({ code: -32002, message });
}

type Handler<Request, Response> = (request: Request) => Effect.Effect<Response, RequestError>;

/** Calls the agent makes to the connected client. */
export interface Client {
	readonly sessionUpdate: (notification: Acp.SessionNotification) => Effect.Effect<void, RequestError>;
}

export interface Handlers {
	readonly initialize: Handler<Acp.InitializeRequest, Acp.InitializeResponse>;
	readonly newSession: Handler<Acp.NewSessionRequest, Acp.NewSessionResponse>;
	/** Must replay the session's history through `Client.sessionUpdate` before it returns. */
	readonly loadSession: Handler<Acp.LoadSessionRequest, Acp.LoadSessionResponse>;
	readonly listSessions: Handler<Acp.ListSessionsRequest, Acp.ListSessionsResponse>;
	readonly setConfigOption: Handler<Acp.SetSessionConfigOptionRequest, Acp.SetSessionConfigOptionResponse>;
	readonly prompt: Handler<Acp.PromptRequest, Acp.PromptResponse>;
	readonly cancel: (notification: Acp.CancelNotification) => Effect.Effect<void>;
}

/**
 * Serves an ACP agent over `stdio` until the client closes its end.
 *
 * Handlers run as fibers on this effect's services; a request the client cancels, or the
 * connection closing, interrupts its fiber.
 */
export const serve = Effect.fn("ACP.serve")(function* (
	stdio: Stdio.Stdio,
	makeHandlers: (client: Client) => Handlers,
): Effect.fn.Return<void, never, Scope.Scope> {
	const context = yield* Effect.context<never>();
	const runExit = Effect.runPromiseExitWith(context);
	const opened = yield* Deferred.make<Acp.AgentConnection>();

	const handlers = makeHandlers({
		sessionUpdate: (notification) =>
			Deferred.await(opened).pipe(
				Effect.flatMap((connection) =>
					Effect.tryPromise({
						try: () => connection.client.notify(Acp.methods.client.session.update, notification),
						catch: (error) => RequestError.internalError(`Failed to send session/update: ${String(error)}`),
					}),
				),
			),
	});

	// A JSON-RPC answer for a handler that didn't succeed; the SDK sends what `handle` throws.
	const toWire = (cause: Cause.Cause<RequestError>): Acp.RequestError => {
		const error = Cause.findErrorOption(cause);
		if (Option.isSome(error)) return new Acp.RequestError(error.value.code, error.value.message);
		if (Cause.hasInterruptsOnly(cause)) return Acp.RequestError.requestCancelled();
		return Acp.RequestError.internalError(undefined, String(Cause.squash(cause)));
	};
	const handle =
		<Params, A>(handler: (params: Params) => Effect.Effect<A, RequestError>) =>
		({ params, signal }: { readonly params: Params; readonly signal: AbortSignal }): Promise<A> =>
			runExit(handler(params), { signal }).then((exit) => {
				if (Exit.isSuccess(exit)) return exit.value;
				throw toWire(exit.cause);
			});

	const input = yield* Stream.toReadableStreamEffect(stdio.stdin);
	const output = new WritableStream<Uint8Array>({
		write: (chunk) => Effect.runPromiseWith(context)(Stream.run(Stream.make(chunk), stdio.stdout())),
	});

	const connection = Acp.agent({ name: "codework" })
		.onRequest("initialize", handle(handlers.initialize))
		.onRequest("session/new", handle(handlers.newSession))
		.onRequest("session/load", handle(handlers.loadSession))
		.onRequest("session/list", handle(handlers.listSessions))
		.onRequest("session/set_config_option", handle(handlers.setConfigOption))
		.onRequest("session/prompt", handle(handlers.prompt))
		.onNotification("session/cancel", handle(handlers.cancel))
		.connect(Acp.ndJsonStream(output, input));
	yield* Deferred.succeed(opened, connection);
	yield* Effect.addFinalizer(() => Effect.sync(() => connection.close()));
	yield* Effect.promise(() => connection.closed);
});

export * as Agent from "./agent.ts";
