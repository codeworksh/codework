// Local to @codeworksh/acp: upstream's agent serves ACP v2 only, which no editor speaks yet.
// This agent serves ACP v1 over the vendored transport and v1 schemas. See VENDOR.md.
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stdio from "effect/Stdio";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import * as AcpSchema from "./_generated/schema-v1.gen.ts";
import * as AcpError from "./errors.ts";
import * as AcpProtocol from "./protocol.ts";
import { runHandler } from "./_internal/shared.ts";

export const PROTOCOL_VERSION = 1;

export const METHODS = {
  initialize: "initialize",
  session_new: "session/new",
  session_load: "session/load",
  session_list: "session/list",
  session_set_config_option: "session/set_config_option",
  session_prompt: "session/prompt",
  session_cancel: "session/cancel",
  session_update: "session/update",
} as const;

const rpc = <const Method extends string, P extends Schema.Top, S extends Schema.Top>(
  method: Method,
  payload: P,
  success: S,
) => Rpc.make(method, { payload, success, error: AcpSchema.Error });

const Rpcs = RpcGroup.make(
  rpc(METHODS.initialize, AcpSchema.InitializeRequest, AcpSchema.InitializeResponse),
  rpc(METHODS.session_new, AcpSchema.NewSessionRequest, AcpSchema.NewSessionResponse),
  rpc(METHODS.session_load, AcpSchema.LoadSessionRequest, AcpSchema.LoadSessionResponse),
  rpc(METHODS.session_list, AcpSchema.ListSessionsRequest, AcpSchema.ListSessionsResponse),
  rpc(
    METHODS.session_set_config_option,
    AcpSchema.SetSessionConfigOptionRequest,
    AcpSchema.SetSessionConfigOptionResponse,
  ),
  rpc(METHODS.session_prompt, AcpSchema.PromptRequest, AcpSchema.PromptResponse),
);

type Handler<Request, Response> = (request: Request) => Effect.Effect<Response, AcpError.AcpError>;

/** Calls the agent makes to the connected client. */
export interface Client {
  readonly sessionUpdate: (
    notification: AcpSchema.SessionNotification,
  ) => Effect.Effect<void, AcpError.AcpError>;
}

export interface Handlers {
  readonly initialize: Handler<AcpSchema.InitializeRequest, AcpSchema.InitializeResponse>;
  readonly newSession: Handler<AcpSchema.NewSessionRequest, AcpSchema.NewSessionResponse>;
  /** Must replay the session's history through `Client.sessionUpdate` before it returns. */
  readonly loadSession: Handler<AcpSchema.LoadSessionRequest, AcpSchema.LoadSessionResponse>;
  readonly listSessions: Handler<AcpSchema.ListSessionsRequest, AcpSchema.ListSessionsResponse>;
  readonly setConfigOption: Handler<
    AcpSchema.SetSessionConfigOptionRequest,
    AcpSchema.SetSessionConfigOptionResponse
  >;
  readonly prompt: Handler<AcpSchema.PromptRequest, AcpSchema.PromptResponse>;
  readonly cancel: (notification: AcpSchema.CancelNotification) => Effect.Effect<void>;
}

const encodeSessionNotification = Schema.encodeEffect(AcpSchema.SessionNotification);
const decodeCancelNotification = Schema.decodeUnknownEffect(AcpSchema.CancelNotification);

/**
 * Serves an ACP v1 agent over `stdio` until the client closes its end.
 *
 * Handlers are built from the connection's `Client` before the first message is read,
 * so no request can arrive ahead of its handler.
 */
export const serve = Effect.fn("@codeworksh/acp/agent.serve")(function* (
  stdio: Stdio.Stdio,
  makeHandlers: (client: Client) => Handlers,
  options: Pick<AcpProtocol.AcpPatchedProtocolOptions, "logIncoming" | "logOutgoing" | "logger"> = {},
): Effect.fn.Return<void, never, Scope.Scope> {
  const closed = yield* Deferred.make<void>();
  let handlers: Handlers | undefined;

  const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
    ...options,
    stdio,
    serverRequestMethods: new Set(Rpcs.requests.keys()),
    onNotification: (notification) => {
      if (notification._tag !== "ExtNotification" || notification.method !== METHODS.session_cancel) {
        return Effect.void;
      }
      return decodeCancelNotification(notification.params).pipe(
        Effect.mapError((error) =>
          AcpError.AcpProtocolParseError.fromSchemaError(
            "decode-notification-payload",
            METHODS.session_cancel,
            error,
          ),
        ),
        Effect.flatMap((decoded) => handlers?.cancel(decoded) ?? Effect.void),
      );
    },
    onExtRequest: (method) => Effect.fail(AcpError.AcpRequestError.methodNotFound(method)),
    onTermination: () => Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
  });

  const client: Client = {
    sessionUpdate: (notification) =>
      encodeSessionNotification(notification).pipe(
        Effect.mapError((error) =>
          AcpError.AcpProtocolParseError.fromSchemaError(
            "encode-message",
            METHODS.session_update,
            error,
          ),
        ),
        Effect.flatMap((encoded) => transport.notify(METHODS.session_update, encoded)),
      ),
  };
  const bound = makeHandlers(client);
  handlers = bound;

  yield* RpcServer.make(Rpcs).pipe(
    Effect.provideService(RpcServer.Protocol, transport.serverProtocol),
    Effect.provide(
      Rpcs.toLayer(
        Rpcs.of({
          [METHODS.initialize]: (payload) => runHandler(bound.initialize, payload, METHODS.initialize),
          [METHODS.session_new]: (payload) => runHandler(bound.newSession, payload, METHODS.session_new),
          [METHODS.session_load]: (payload) =>
            runHandler(bound.loadSession, payload, METHODS.session_load),
          [METHODS.session_list]: (payload) =>
            runHandler(bound.listSessions, payload, METHODS.session_list),
          [METHODS.session_set_config_option]: (payload) =>
            runHandler(bound.setConfigOption, payload, METHODS.session_set_config_option),
          [METHODS.session_prompt]: (payload) =>
            runHandler(bound.prompt, payload, METHODS.session_prompt),
        }),
      ),
    ),
    Effect.forkScoped,
  );

  yield* Deferred.await(closed);
});
