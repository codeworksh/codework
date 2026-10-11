/* @effect-diagnostics nodeBuiltinImport:off -- the registration is a file at a fixed host path. */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, FileSystem, Layer, Schema } from "effect";

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
	/** The `ws://host:port/rpc` endpoint a client connects to. */
	url: Schema.String,
	/** The TCP port the server bound, for a caller that would rather reuse it than default. */
	port: Schema.Int,
});
export type Info = typeof Info.Type;

export const infoJson = Schema.fromJsonString(Info);

/** The registration file for a CodeWork home: `<home>/service.json`. */
export const file = (home: string) => `${home}/service.json`;

const decode = Schema.decodeUnknownEffect(infoJson);

export const write = Effect.fn("ServerRegistration.write")(function* (path: string, info: Info) {
	const fs = yield* FileSystem.FileSystem;
	yield* fs.makeDirectory(dirname(path), { recursive: true });
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
 */
export const register = (options: { readonly home: string; readonly info: Info }) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const path = file(options.home);
			yield* write(path, options.info);
			const fs = yield* FileSystem.FileSystem;
			yield* Effect.addFinalizer(() =>
				// Remove the file only while it is still ours; a newer server that took
				// over must keep the registration that names it.
				fs.readFileString(path).pipe(
					Effect.flatMap(decode),
					Effect.flatMap((found) =>
						found.pid === options.info.pid && found.url === options.info.url
							? fs.remove(path)
							: Effect.void,
					),
					Effect.ignore,
				),
			);
		}),
	);

/**
 * The launcher command for a managed server: this same CLI, asked to serve.
 *
 * A packaged install runs `dist/pack/index.mjs`; under `--conditions=development`
 * the entry is TypeScript, and `process.execArgv` carries the conditions forward
 * so a managed server resolves workspace sources the same way this process did.
 */
export const command = (): ReadonlyArray<string> => {
	const entry = process.argv[1];
	if (entry === undefined) return [process.execPath];
	const runtime = fileURLToPath(import.meta.url).endsWith(".ts") ? process.execArgv : [];
	return [process.execPath, ...runtime, entry];
};

export * as Registration from "./registration.ts";
