import { Codework as Mirror } from "@codeworksh/widget/codework";
import { Codework as Client } from "@codeworksh/widget/backend";
import { NodeSocket } from "@effect/platform-node";
import { Deferred, Effect, FileSystem, Layer, Schedule, Schema, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
/* @effect-diagnostics nodeBuiltinImport:off -- a home's registration is a file path. */
import path from "node:path";
import { CodeworkUnavailable } from "./contract.ts";
import { Servers } from "./servers.ts";

export type SessionInfo = Mirror.SessionInfo;

/** How a running server advertises itself: `<home>/service.json`, written by `codework serve`. */
const Registration = Schema.fromJsonString(
	Schema.Struct({ pid: Schema.Int, version: Schema.String, url: Schema.String, port: Schema.Int }),
);

/** The server `<home>/service.json` names, read fresh; a missing or unreadable file is none. */
export const registrationAt = (home: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return yield* fs
			.readFileString(path.join(home, "service.json"))
			.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Registration)), Effect.option);
	});

/** The server the default server's home names: the one the app connects to. */
export const registration = Effect.gen(function* () {
	return yield* registrationAt(yield* (yield* Servers.Service).defaultHome);
});

/**
 * The connection ends when the home changes, as if the server went away: the client reconnects, and
 * so reads the new home's registration, and its callers resubscribe as after any drop.
 */
const endOnHomeChange = (socket: Socket.Socket, changes: Stream.Stream<string>): Socket.Socket => ({
	...socket,
	// Watched from when the connection opens, so a change between two reads still ends it.
	reader: Effect.gen(function* () {
		const reader = yield* socket.reader;
		const changed = yield* Deferred.make<void>();
		yield* Stream.runHead(changes).pipe(Effect.andThen(Deferred.succeed(changed, undefined)), Effect.forkScoped);
		const closed = Deferred.await(changed).pipe(
			Effect.andThen(Effect.fail(new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1000 }) }))),
		);
		return { ...reader, pull: reader.pull.pipe(Effect.raceFirst(closed)) };
	}),
});

/**
 * The app's one connection to a CodeWork server: the default server's. The registration is read on
 * every connect, so a server restarted on a new port, a new home or a new default is picked up
 * without restarting this app; until one is registered, connecting waits.
 */
export const layer = Layer.effect(Client, RpcClient.make(Mirror.Api, { flatten: true })).pipe(
	Layer.provide(RpcClient.layerProtocolSocket({ retryTransientErrors: true })),
	Layer.provide(
		Layer.effect(
			Socket.Socket,
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const servers = yield* Servers.Service;
				const url = registration.pipe(
					Effect.flatMap(Effect.fromOption),
					Effect.map((registered) => registered.url),
					Effect.retry(Schedule.spaced("1 second")),
					Effect.orDie,
					Effect.provideService(FileSystem.FileSystem, fs),
					Effect.provideService(Servers.Service, servers),
					// The socket reads its URL while opening, which Effect runs uninterruptibly; waiting there
					// for a server to register would otherwise keep the app server from ever shutting down.
					Effect.interruptible,
				);
				return endOnHomeChange(yield* Socket.makeWebSocket(url), servers.homeChanges);
			}),
		).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor)),
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
