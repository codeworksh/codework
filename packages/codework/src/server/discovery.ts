/* @effect-diagnostics nodeBuiltinImport:off -- a detached managed server is started through node. */
import { Clock, Effect, FileSystem, Schema } from "effect";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Health } from "./health.ts";
import { Registration } from "./registration.ts";

/**
 * The CodeWork home a managed server and its registration share.
 *
 * `--home` wins, then `CODEWORK_HOME_DIR` (the harness default), then
 * `~/.codework`. `~` expands because the CLI accepts it and the harness does
 * too; keeping the two spellings identical is what lets discovery find the file
 * the server wrote.
 */
export const home = (explicit?: string): string => {
	const value = explicit ?? process.env["CODEWORK_HOME_DIR"] ?? join(homedir(), ".codework");
	const expanded = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
	return isAbsolute(expanded) ? expanded : resolve(expanded);
};

/** What a caller gets back: the endpoint to connect a TUI or `run` to. */
export interface Endpoint {
	readonly url: string;
}

/** A managed server could not be produced, in the words the CLI prints. */
export class ServerStartError extends Schema.TaggedError<ServerStartError>()("Discovery.ServerStartError", {
	message: Schema.String,
}) {}

const decode = Schema.decodeUnknownEffect(Registration.infoJson);

const read = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const text = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => undefined));
		if (text === undefined) return undefined;
		return yield* decode(text).pipe(Effect.orElseSucceed(() => undefined));
	});

/**
 * Reuse a registered server if it answers; otherwise retire the stale file.
 *
 * The registration is a hint, not proof: only a live `server.info` answer with
 * matching pid and version is trusted, and a file nothing answers for is removed
 * so it cannot mislead the next caller.
 */
const reuse = (path: string) =>
	Effect.gen(function* () {
		const info = yield* read(path);
		if (info === undefined) return undefined;
		if (yield* Health.matches(info)) return { url: info.url } satisfies Endpoint;
		yield* Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			yield* fs.remove(path);
		}).pipe(Effect.ignore);
		return undefined;
	});

/**
 * Ensure a healthy local server for `home`, reusing the registered one when it
 * answers and starting a managed server when it does not.
 *
 * The managed server is a detached process that outlives this caller, so the
 * next invocation reuses it rather than starting another. When two callers race,
 * both may start a contender, but only the one that binds the port can register;
 * the loser exits and both callers adopt the winner, because discovery only ever
 * believes a registration it can confirm over the wire.
 */
export const ensure = (options: {
	readonly home: string;
	readonly host: string;
	readonly port: number;
	readonly args: ReadonlyArray<string>;
	readonly env: NodeJS.ProcessEnv;
	readonly onStart?: () => void;
}) =>
	Effect.gen(function* () {
		const path = Registration.file(options.home);
		const existing = yield* reuse(path);
		if (existing !== undefined) return existing;

		yield* Effect.sync(() => options.onStart?.());
		yield* startDetached(options);

		const deadline = (yield* Clock.currentTimeMillis) + START_TIMEOUT_MS;
		while ((yield* Clock.currentTimeMillis) < deadline) {
			yield* Effect.sleep("250 millis");
			const info = yield* read(path);
			if (info !== undefined && (yield* Health.matches(info))) return { url: info.url } satisfies Endpoint;
		}

		return yield* new ServerStartError({
			message:
				`could not start a CodeWork server on ${options.host}:${options.port}. ` +
				"Run `codework serve` to see why, or point `codework tui --server` at a running server.",
		});
	});

const START_TIMEOUT_MS = 20_000;

/**
 * Spawns `codework serve` detached from this process, inheriting the caller's
 * environment so the child resolves the same home, catalog and credentials.
 * `unref` lets the caller exit without waiting on or signalling the server.
 */
const startDetached = (options: {
	readonly host: string;
	readonly port: number;
	readonly args: ReadonlyArray<string>;
	readonly env: NodeJS.ProcessEnv;
}) =>
	Effect.sync(() => {
		const [file, ...base] = Registration.command();
		if (file === undefined) throw new Error("could not resolve the codework entrypoint");
		const child = spawn(
			file,
			[...base, ...options.args, "serve", "--host", options.host, "--port", String(options.port)],
			{ detached: true, stdio: "ignore", env: options.env },
		);
		child.unref();
	});

export * as Discovery from "./discovery.ts";
