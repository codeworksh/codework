import { Codework as Mirror } from "@codeworksh/widget/codework";
import { Codework as Client } from "@codeworksh/widget/backend";
import { NodeSocket } from "@effect/platform-node";
import {
	Config,
	Context,
	Deferred,
	Effect,
	FileSystem,
	Layer,
	Option,
	Schedule,
	Schema,
	Stream,
	SubscriptionRef,
} from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
/* @effect-diagnostics nodeBuiltinImport:off -- the default home sits under the OS home directory. */
import os from "node:os";
import path from "node:path";
import { CodeworkUnavailable } from "./contract.ts";
import { Kv } from "./kv.ts";

export type SessionInfo = Mirror.SessionInfo;

/** How a running server advertises itself: `<home>/service.json`, written by `codework serve`. */
const Registration = Schema.fromJsonString(
	Schema.Struct({ pid: Schema.Int, version: Schema.String, url: Schema.String, port: Schema.Int }),
);

/** The same home the CLI resolves: CODEWORK_HOME_DIR, else ~/.codework. */
const cliHome = Config.String("CODEWORK_HOME_DIR").pipe(Config.withDefault(path.join(os.homedir(), ".codework")));

const homeKey = { package: "codework", key: "servers.local.home" } as const;

/** The CodeWork home the app connects through: the one chosen in Settings, else the CLI's own. */
export class Home extends Context.Service<
	Home,
	{
		/** The home in use; `fallback` is the one used when none is chosen. */
		readonly get: Effect.Effect<{ readonly path: string; readonly custom: boolean; readonly fallback: string }>;
		/** Saves the choice; `null` goes back to the CLI's home. */
		readonly set: (path: string | null) => Effect.Effect<void>;
		/** The home's path each time the choice changes, without the current one. */
		readonly changes: Stream.Stream<string>;
	}
>()("@codeworksh/server/codework/Home") {}

export const homeLayer = Layer.effect(
	Home,
	Effect.gen(function* () {
		const kv = yield* Kv.Service;
		const fallback = yield* cliHome.pipe(Effect.orDie);
		const saved = yield* kv.get(homeKey.package, homeKey.key);
		const chosen = yield* SubscriptionRef.make(
			Option.flatMap(saved, (value) => (typeof value === "string" ? Option.some(value) : Option.none())),
		);
		const get = SubscriptionRef.get(chosen).pipe(
			Effect.map(
				Option.match({
					onNone: () => ({ path: fallback, custom: false, fallback }),
					onSome: (chosenPath) => ({ path: chosenPath, custom: true, fallback }),
				}),
			),
		);
		return Home.of({
			get,
			set: (next) =>
				kv
					.set(homeKey.package, homeKey.key, next)
					.pipe(Effect.andThen(SubscriptionRef.set(chosen, Option.fromNullOr(next)))),
			changes: SubscriptionRef.changes(chosen).pipe(
				Stream.drop(1),
				Stream.mapEffect(() => get),
				Stream.map((current) => current.path),
			),
		});
	}),
);

/** The server the home's `service.json` names, read fresh; a missing or unreadable file is none. */
export const registration = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const file = path.join((yield* (yield* Home).get).path, "service.json");
	return yield* fs.readFileString(file).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Registration)), Effect.option);
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
 * The app's one connection to the CodeWork server. The registration is read on every connect, so a
 * server restarted on a new port, or a new home, is picked up without restarting this app; until
 * one is registered, connecting waits.
 */
export const layer = Layer.effect(Client, RpcClient.make(Mirror.Api, { flatten: true })).pipe(
	Layer.provide(RpcClient.layerProtocolSocket({ retryTransientErrors: true })),
	Layer.provide(
		Layer.effect(
			Socket.Socket,
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const home = yield* Home;
				const url = registration.pipe(
					Effect.flatMap(Effect.fromOption),
					Effect.map((registered) => registered.url),
					Effect.retry(Schedule.spaced("1 second")),
					Effect.orDie,
					Effect.provideService(FileSystem.FileSystem, fs),
					Effect.provideService(Home, home),
				);
				return endOnHomeChange(yield* Socket.makeWebSocket(url), home.changes);
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
