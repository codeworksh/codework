import { NodeSocket } from "@effect/platform-node";
import { Config, Effect, FileSystem, Schema } from "effect";
import { Rpc, RpcClient, RpcGroup, RpcSerialization } from "effect/rpc";
/* @effect-diagnostics nodeBuiltinImport:off -- the default home sits under the OS home directory. */
import os from "node:os";
import path from "node:path";
import { CodeworkUnavailable, HistoryEntry } from "./contract.ts";

/*
 * The CodeWork server's RPC contract, mirrored for the calls this app makes. The source of truth
 * is packages/codework/src/server/contract.ts; keep these in step until both import a shared
 * schema package.
 */

const SessionInfo = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	directory: Schema.String,
	hostDir: Schema.optionalKey(Schema.String),
	project: Schema.optionalKey(Schema.Struct({ id: Schema.String, name: Schema.String })),
	updatedAt: Schema.Finite,
	model: Schema.optionalKey(Schema.Struct({ provider: Schema.String, id: Schema.String })),
});
export type SessionInfo = typeof SessionInfo.Type;

/** The server's "no such session" (the harness `SessionNotFoundError`), by its wire tag. */
export class SessionNotFoundError extends Schema.TaggedError<SessionNotFoundError>()("SessionNotFoundError", {
	sessionId: Schema.String,
}) {}

const Api = RpcGroup.make(
	Rpc.make("server.info", {
		payload: {},
		success: Schema.Struct({ pid: Schema.Int, version: Schema.String }),
	}),
	Rpc.make("session.list", {
		payload: {},
		success: Schema.Array(SessionInfo),
	}),
	Rpc.make("session.info", {
		payload: { sessionId: Schema.String },
		success: SessionInfo,
		error: SessionNotFoundError,
	}),
	Rpc.make("session.history", {
		payload: { sessionId: Schema.String },
		success: Schema.Struct({ entries: Schema.Array(HistoryEntry) }),
		error: SessionNotFoundError,
	}),
);

const make = RpcClient.make(Api);
type Client = Effect.Success<typeof make>;

/** How a running server advertises itself: `<home>/service.json`, written by `codework serve --service`. */
const Registration = Schema.fromJsonString(
	Schema.Struct({ pid: Schema.Int, version: Schema.String, url: Schema.String, port: Schema.Int }),
);

// The same home the CLI resolves: CODEWORK_HOME_DIR, else ~/.codework.
const home = Config.String("CODEWORK_HOME_DIR").pipe(Config.withDefault(path.join(os.homedir(), ".codework")));

const endpoint = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const file = path.join(yield* home, "service.json");
	const text = yield* fs.readFileString(file);
	return yield* Schema.decodeUnknownEffect(Registration)(text);
}).pipe(
	Effect.mapError(
		() =>
			new CodeworkUnavailable({
				message: "No CodeWork server is running. Start one with `codework service start`.",
			}),
	),
);

/**
 * Runs one call against the registered server over a connection opened for it. The registration
 * is read each time, so a restarted server (new port) is picked up without restarting this app.
 * The file is only a hint: the call failing is what tells a stale one apart.
 */
export const call = <A, E>(use: (client: Client) => Effect.Effect<A, E>) =>
	Effect.gen(function* () {
		const { url } = yield* endpoint;
		return yield* Effect.scoped(Effect.flatMap(make, use)).pipe(
			Effect.provide(RpcClient.layerProtocolSocket()),
			Effect.provide(NodeSocket.layerWebSocket(url)),
			Effect.provide(RpcSerialization.layerNdjson),
			Effect.timeout("5 seconds"),
			// A server down and a server of another build (a reply this mirror cannot decode) both land here.
			Effect.catchCause(() =>
				Effect.fail(
					new CodeworkUnavailable({
						message: `No usable reply from the CodeWork server at ${url}. It may be stopped, or running a build older than this app.`,
					}),
				),
			),
		);
	});

export * as Codework from "./codework.ts";
