import { Effect, FileSystem, Layer, Schedule, Schema } from "effect";
import { isSea } from "node:sea";
import * as Private from "../framework/private.ts";

/**
 * How a running server advertises itself so later invocations can find it
 * without scanning ports or the process table.
 *
 * The file is a discovery hint, never proof: a caller reads it for the endpoint,
 * then asks the endpoint `server.info` and believes the answer only when the
 * live pid and version match the ones on file. A crashed server leaves a
 * registration behind; the failed probe is what retires it.
 */
export const Info = Schema.Struct({
	/** Operating system process identifier of the server that wrote this. */
	pid: Schema.Int,
	/** The build serving this endpoint; a mismatch means a different binary. */
	version: Schema.String,
	/** The `ws://host:port/rpc/v1` endpoint a client connects to. */
	url: Schema.String,
	/** The TCP port the server bound, for a caller that would rather reuse it than default. */
	port: Schema.Int,
	/** The server's token for the life of its process: a local client sends it on every call. */
	token: Schema.String,
});
export type Info = typeof Info.Type;

const infoJson = Schema.fromJsonString(Info);

/** The registration file for a CodeWork home: `<home>/service.json`. */
export const file = (home: string) => `${home}/service.json`;

/** Where a background (`serve --service`) server writes its log: `<log>/server.log`, truncated per start. */
export const log = (logDir: string) => `${logDir}/server.log`;

const decode = Schema.decodeUnknownEffect(infoJson);

/** The registration at `path`; a missing or unreadable file is none. */
export const read = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return yield* fs.readFileString(path).pipe(
			Effect.flatMap(decode),
			Effect.orElseSucceed(() => undefined),
		);
	});

// Private because it carries the token.
const write = (path: string, info: Info) =>
	Schema.encodeEffect(infoJson)(info).pipe(Effect.flatMap((encoded) => Private.write(path, encoded)));

/**
 * Publishes a registration for as long as this server lives, removing it on the
 * way out if it is still the one on file. A file left by a crash is overwritten
 * by the next server to start, and retired by a probe that cannot confirm it.
 *
 * One home has one discoverable server. Every few seconds the file is checked:
 * a missing or unreadable file is written again, and a file naming another
 * server means this one lost discovery for good, so it shuts down rather than
 * run on where nothing can find or stop it.
 */
export const register = (options: { readonly home: string; readonly info: Info }) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const path = file(options.home);
			const fs = yield* FileSystem.FileSystem;
			const current = read(path);
			const owns = (found: Info) => found.pid === options.info.pid && found.url === options.info.url;

			yield* write(path, options.info);
			yield* Effect.addFinalizer(() =>
				current.pipe(
					Effect.flatMap((found) => (found !== undefined && owns(found) ? fs.remove(path) : Effect.void)),
					Effect.ignore,
				),
			);
			// Forked after the finalizer, so shutdown stops the watch before the file is removed.
			yield* current.pipe(
				Effect.flatMap((found) =>
					found === undefined
						? write(path, options.info).pipe(Effect.ignore, Effect.as(true))
						: Effect.succeed(owns(found)),
				),
				Effect.repeat({ while: (ours) => ours, schedule: Schedule.spaced("5 seconds") }),
				Effect.andThen(Effect.logWarning(`${path} names another server; shutting down`)),
				// The same graceful path `codework service stop` takes.
				Effect.andThen(Effect.sync(() => process.kill(process.pid, "SIGTERM"))),
				Effect.forkScoped,
			);
		}),
	);

/**
 * The launcher command for a managed server: this same CLI, asked to serve.
 *
 * A packaged install runs `dist/pack/index.mjs`; under `--conditions=development`
 * the entry is TypeScript, and `process.execArgv` carries the conditions forward
 * so a managed server resolves workspace sources the same way this process did.
 * The standalone binary is its own entry.
 */
export const command = (): ReadonlyArray<string> => {
	if (isSea()) return [process.execPath];
	const entry = process.argv[1];
	if (entry === undefined) return [process.execPath];
	const runtime = import.meta.url.endsWith(".ts") ? process.execArgv : [];
	return [process.execPath, ...runtime, entry];
};
