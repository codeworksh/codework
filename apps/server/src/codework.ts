import { Codework as Mirror } from "@codeworksh/widget/codework";
import { Codework as Client } from "@codeworksh/widget/backend";
import { NodeSocket } from "@effect/platform-node";
import { Config, Effect, FileSystem, Layer, Schedule, Schema } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
/* @effect-diagnostics nodeBuiltinImport:off -- the default home sits under the OS home directory. */
import os from "node:os";
import path from "node:path";
import { CodeworkUnavailable } from "./contract.ts";

export type SessionInfo = Mirror.SessionInfo;

/** How a running server advertises itself: `<home>/service.json`, written by `codework serve`. */
const Registration = Schema.fromJsonString(
	Schema.Struct({ pid: Schema.Int, version: Schema.String, url: Schema.String, port: Schema.Int }),
);

// The same home the CLI resolves: CODEWORK_HOME_DIR, else ~/.codework.
const home = Config.String("CODEWORK_HOME_DIR").pipe(Config.withDefault(path.join(os.homedir(), ".codework")));

/**
 * The app's one connection to the CodeWork server. The registration is read on every connect, so a
 * server restarted on a new port is picked up without restarting this app; until one is
 * registered, connecting waits.
 */
export const layer = Layer.effect(Client, RpcClient.make(Mirror.Api, { flatten: true })).pipe(
	Layer.provide(RpcClient.layerProtocolSocket({ retryTransientErrors: true })),
	Layer.provide(
		Layer.unwrap(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const file = path.join(yield* home, "service.json");
				const url = fs.readFileString(file).pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Registration)),
					Effect.map((registration) => registration.url),
					Effect.retry(Schedule.spaced("1 second")),
					Effect.orDie,
				);
				return NodeSocket.layerWebSocket(url);
			}),
		),
	),
	Layer.provide(RpcSerialization.layerNdjson),
	Layer.orDie,
);

/**
 * One call on behalf of the app's own RPC handlers. A server that is down, or of another build (a
 * reply this mirror cannot decode), surfaces as `CodeworkUnavailable`.
 */
export const call = <A, E>(use: (client: typeof Client.Service) => Effect.Effect<A, E>) =>
	Client.use(use).pipe(
		Effect.timeout("5 seconds"),
		Effect.catchCause(() =>
			Effect.fail(
				new CodeworkUnavailable({
					message:
						"No usable reply from the CodeWork server. Start one with `codework service start`; it may also be running a build older than this app.",
				}),
			),
		),
	);

export * as Codework from "./codework.ts";
