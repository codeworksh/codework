import { Codework as Mirror } from "@codeworksh/widget/codework";
import { Codework as Client } from "@codeworksh/widget/backend";
import { NodeSocket } from "@effect/platform-node";
import { Deferred, Duration, Effect, FileSystem, Layer, Option, Schedule, Schema, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
/* @effect-diagnostics nodeBuiltinImport:off -- a home's registration is a file path. */
import path from "node:path";
import { CodeworkUnavailable, HostError } from "@codeworksh/contract";
import { Door } from "@codeworksh/schema";
import { Pairing } from "./pairing.ts";
import { Servers } from "./servers.ts";

/** How a running server advertises itself: `<home>/service.json`, written by `codework serve`. */
const Registration = Schema.fromJsonString(
	Schema.Struct({
		pid: Schema.Int,
		version: Schema.String,
		url: Schema.String,
		port: Schema.Int,
		/** The home's token, offered as the socket opens. */
		token: Schema.String,
	}),
);

/** The server `<home>/service.json` names, read fresh; a missing or unreadable file is none. */
export const registrationAt = (home: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return yield* fs
			.readFileString(path.join(home, "service.json"))
			.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Registration)), Effect.option);
	});

/** Where a server is reached, and the credential its door takes: the home's token, or a ticket. */
interface Target {
	readonly url: string;
	readonly token: string | undefined;
}

/**
 * A socket to the server `target` reads, read afresh on every open, so its URL and token always
 * belong to the same server: a restarted one may have another port.
 */
const open = <R>(
	target: Effect.Effect<Target, Socket.SocketError, R>,
	options?: { readonly openTimeout?: Duration.Input },
) =>
	Socket.WebSocketConstructor.use((make) =>
		Socket.fromWebSocket(
			Effect.acquireRelease(
				Effect.map(target, ({ url, token }) => make(url, Door.protocols(token))),
				(ws) => Effect.sync(() => ws.close(1000)),
			),
			options,
		),
	);

/**
 * Whether a server lets this app in at `target`: its WebSocket opens. A registration's pid says
 * nothing here, since the server may run on another OS than this app, as one in WSL does for the
 * Windows app.
 */
export const reachable = (target: Target) =>
	open(Effect.succeed(target), { openTimeout: "2 seconds" }).pipe(
		Effect.flatMap((socket) => Effect.scoped(socket.reader)),
		Effect.isSuccess,
		Effect.provide(NodeSocket.layerWebSocketConstructor),
	);

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

/** A client over `socket`, which reconnects on its own. */
const connect = <R>(socket: Layer.Layer<Socket.Socket, never, R>) =>
	Layer.effect(Client, RpcClient.make(Mirror.Api, { flatten: true })).pipe(
		Layer.provide(RpcClient.layerProtocolSocket({ retryTransientErrors: true })),
		Layer.provide(socket.pipe(Layer.provide(NodeSocket.layerWebSocketConstructor))),
		Layer.provide(RpcSerialization.layerNdjson),
		Layer.orDie,
	);

type Found = { readonly url: string; readonly token: string };

/**
 * What `registered` reads, waited for until there is one. The socket reads it while opening,
 * which Effect runs uninterruptibly; waiting there for a server to register would otherwise keep the
 * app server from ever shutting down.
 */
const waitFor = (registered: Effect.Effect<Option.Option<Found>>) =>
	registered.pipe(
		Effect.flatMap(Effect.fromOption),
		Effect.retry(Schedule.spaced("1 second")),
		Effect.orDie,
		Effect.interruptible,
	);

/** A client of the local server `registered` names, read on every connect. */
const local = <R>(
	registered: Effect.Effect<Option.Option<Found>, never, R>,
	wrap: (socket: Socket.Socket) => Effect.Effect<Socket.Socket, never, R> = Effect.succeed,
) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const found = waitFor(Effect.provideContext(registered, yield* Effect.context<R>()));
			return connect(Layer.effect(Socket.Socket, open(found).pipe(Effect.flatMap(wrap))));
		}),
	);

/**
 * The app's connection to the default server. The registration is read on every connect, so a server
 * restarted on a new port, a new home or a new default is picked up without restarting this app;
 * until one is registered, connecting waits.
 */
export const layer = local(registration, (socket) =>
	Servers.Service.use((servers) => Effect.succeed(endOnHomeChange(socket, servers.homeChanges))),
);

/**
 * A remote server's URL with a fresh ticket for this app's key, taken on every connect. A server that
 * refuses the key (revoked or lapsed) has the pairing dropped from the row, which ends this connection
 * (the sync follows the row), so it waits rather than asking again; so does a row without one. Only a
 * refusal signed with the key it paired with counts: any other answer marks the address as another
 * machine's, and a refusal from a clock past the proof window marks the clocks apart. Neither is
 * connected to; the attempt fails, so the connection tries again later. Interruptible, as {@link waitFor} is.
 */
const ticketed = (row: Servers.RemoteRow) =>
	Effect.gen(function* () {
		const { device, machineKey } = row;
		if (device === null || machineKey === null) return yield* Effect.never;
		const servers = yield* Servers.Service;
		const failed = (cause: unknown) =>
			new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) });
		const answer = yield* Pairing.ticket(row.url, device, servers.deviceKey, machineKey).pipe(
			Effect.mapError(failed),
		);
		switch (answer._tag) {
			case "Ticket":
				yield* servers.answered(row.id, null);
				return { url: row.url, token: answer.ticket };
			case "Stranger":
				yield* servers.answered(row.id, { kind: "machine", fingerprint: answer.fingerprint });
				return yield* Effect.fail(failed("The address answers as a different Machine"));
			case "Clock":
				yield* servers.answered(row.id, { kind: "clock", skew: answer.skew });
				return yield* Effect.fail(failed("This computer's clock differs from the Machine's"));
			case "Refused":
				yield* servers.unpair(row.id, device);
				return yield* Effect.never;
		}
	}).pipe(Effect.interruptible);

/**
 * A connection to one machine's server: a remote one at its URL with a ticket per socket, a local
 * one at what its home registers, read on every connect as {@link layer} does.
 */
export const machine = (row: Servers.Row) =>
	row.kind === "remote"
		? connect(Layer.effect(Socket.Socket, open(ticketed(row))))
		: local(
				Effect.gen(function* () {
					return yield* registrationAt((yield* Servers.Service).homeOf(row).path);
				}),
			);

export interface CallOptions {
	/** How long the server has to answer; 5 seconds unless given. */
	readonly timeout?: Duration.Input;
}

/**
 * One call on behalf of the app's own RPC handlers. A server that is down, or of another build (a
 * reply this mirror cannot decode), surfaces as `CodeworkUnavailable`.
 */
export const call = <A, E>(use: (client: typeof Client.Service) => Effect.Effect<A, E>, options: CallOptions = {}) =>
	Client.use(use).pipe(
		Effect.timeout(options.timeout ?? "5 seconds"),
		Effect.catchCause(() => Effect.fail(unavailable())),
	);

const unavailable = () =>
	new CodeworkUnavailable({
		message:
			"No usable reply from the CodeWork server. Start one with `codework service start`; it may also be running a build older than this app.",
	});

/**
 * A stream on behalf of the app's own RPC handlers. A dropped connection, or a reply this mirror
 * cannot decode, ends it as `CodeworkUnavailable`, so its subscriber subscribes again.
 */
export const stream = <A, E>(use: (client: typeof Client.Service) => Stream.Stream<A, E>) =>
	Stream.unwrap(Client.use((client) => Effect.succeed(use(client)))).pipe(
		Stream.catchCause(() => Stream.fail(unavailable())),
	);

const isHostError = Schema.is(Mirror.HostError);

/** {@link call} for a host operation: the server's `HostError` reaches the app as its own, with its message. */
export const callHost = <A, E>(
	use: (client: typeof Client.Service) => Effect.Effect<A, E | Mirror.HostError>,
	options: CallOptions = {},
) =>
	call(
		(client) =>
			use(client).pipe(
				Effect.map((value) => ({ value })),
				Effect.catchIf(isHostError, (error) =>
					Effect.succeed({ failed: new HostError({ message: error.message }) }),
				),
			),
		options,
	).pipe(Effect.flatMap((reply) => ("failed" in reply ? Effect.fail(reply.failed) : Effect.succeed(reply.value))));

export * as Codework from "./codework.ts";
