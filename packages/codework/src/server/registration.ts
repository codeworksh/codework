import { Effect, FileSystem, Layer, Option, Path, Schedule, Schema } from "effect";
import { isSea } from "node:sea";

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
});
export type Info = typeof Info.Type;

export const infoJson = Schema.fromJsonString(Info);

/** The registration file for a CodeWork home: `<home>/service.json`. */
export const file = (home: string) => `${home}/service.json`;

/** Where a background (`serve --service`) server writes its log: `<log>/server.log`, truncated per start. */
export const log = (logDir: string) => `${logDir}/server.log`;

const decode = Schema.decodeUnknownEffect(infoJson);

export const write = Effect.fn("ServerRegistration.write")(function* (path: string, info: Info) {
	const fs = yield* FileSystem.FileSystem;
	const paths = yield* Path.Path;
	yield* fs.makeDirectory(paths.dirname(path), { recursive: true });
	const encoded = yield* Schema.encodeEffect(infoJson)(info);
	// Write beside the target and rename, so a reader never sees a half-written
	// file. 0600 because a future registration may carry a credential.
	const temp = `${path}.${info.pid}.tmp`;
	yield* fs.writeFileString(temp, encoded, { mode: 0o600 });
	yield* fs.rename(temp, path);
});

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
			const current = fs.readFileString(path).pipe(Effect.flatMap(decode), Effect.option);
			const owns = (found: Info) => found.pid === options.info.pid && found.url === options.info.url;

			yield* write(path, options.info);
			yield* Effect.addFinalizer(() =>
				current.pipe(
					Effect.flatMap((found) => (Option.isSome(found) && owns(found.value) ? fs.remove(path) : Effect.void)),
					Effect.ignore,
				),
			);
			// Forked after the finalizer, so shutdown stops the watch before the file is removed.
			yield* current.pipe(
				Effect.flatMap((found) =>
					Option.isNone(found)
						? write(path, options.info).pipe(Effect.ignore, Effect.as(true))
						: Effect.succeed(owns(found.value)),
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

export * as Registration from "./registration.ts";
