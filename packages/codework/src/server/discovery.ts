import { type Duration, Effect, FileSystem, Option, Ref, Schedule, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Health } from "./health.ts";
import { Identity } from "./identity.ts";
import { Registration } from "./registration.ts";

/** A server a client can connect to, and the process and port behind it. */
export interface Endpoint {
	readonly url: string;
	readonly pid: number;
	readonly port: number;
}

/** A managed server could not be produced, in the words the CLI prints. */
export class ServerStartError extends Schema.TaggedError<ServerStartError>()("Discovery.ServerStartError", {
	message: Schema.String,
}) {}

export interface Options {
	/** The CodeWork home whose `service.json` names the server. */
	readonly home: string;
	/** The home's log directory, where a background server writes `server.log`. */
	readonly log: string;
	readonly host: string;
	readonly port: number;
	/** Server-owned flags placed before `serve`. */
	readonly args: ReadonlyArray<string>;
}

const START_TIMEOUT = "20 seconds";
const RACE_GRACE = "2 seconds";
const STOP_TIMEOUT = "5 seconds";

const decode = Schema.decodeUnknownEffect(Registration.infoJson);

const read = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const text = yield* fs.readFileString(path).pipe(Effect.option);
		if (Option.isNone(text)) return undefined;
		return yield* decode(text.value).pipe(Effect.option, Effect.map(Option.getOrUndefined));
	});

const remove = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* fs.remove(path);
	}).pipe(Effect.ignore);

/** Whether `pid` is a running process. EPERM means it exists but belongs to someone else. */
const alive = (pid: number) =>
	Effect.try({ try: () => process.kill(pid, 0), catch: (error) => (error as NodeJS.ErrnoException).code }).pipe(
		Effect.as(true),
		Effect.catch((code) => Effect.succeed(code === "EPERM")),
	);

/** Whether `pid` exits within `timeout`. */
const exits = (pid: number, timeout: typeof STOP_TIMEOUT) =>
	alive(pid).pipe(
		Effect.repeat({ while: (running) => running, schedule: Schedule.spaced("50 millis") }),
		Effect.timeoutOption(timeout),
		Effect.map(Option.isSome),
	);

/**
 * The registered server, with `live` set when the process answering its endpoint
 * is the one that registered. The file is a hint, never proof: a different server
 * on a reused port must not pass for it.
 */
const registered = (path: string) =>
	Effect.gen(function* () {
		const info = yield* read(path);
		if (info === undefined) return undefined;
		const live = yield* Health.probe(info.url);
		return { info, live: live?.pid === info.pid ? live : undefined };
	});

const endpoint = (info: Registration.Info): Endpoint => ({ url: info.url, pid: info.pid, port: info.port });

/** The running server registered for `home`, with the build it reports. */
export const discover = (home: string) =>
	registered(Registration.file(home)).pipe(
		Effect.map((found) =>
			found?.live === undefined ? undefined : { ...endpoint(found.info), version: found.live.version },
		),
	);

/**
 * Stop the server registered for `home`, returning it, or undefined when none
 * answers. Only a server that confirms it is the registrant is signalled: a pid
 * on file may since have been reused by an unrelated process.
 */
export const stop = (home: string) =>
	Effect.gen(function* () {
		const path = Registration.file(home);
		const found = yield* registered(path);
		if (found === undefined) return undefined;
		if (found.live === undefined) {
			if (!(yield* alive(found.info.pid))) yield* remove(path);
			return undefined;
		}
		yield* terminate(path, found.info.pid);
		return endpoint(found.info);
	});

/**
 * Ensure a healthy local server for `home`: reuse the registered one, replace it
 * when `replace` is set and it runs a different build, or start a background one.
 *
 * The background server is detached and outlives this caller, so the next
 * invocation reuses it. When two callers race, only the contender that binds the
 * port registers; the loser exits and both adopt the winner, because a caller
 * only ever believes a registration it can confirm over the wire.
 */
export const ensure = (
	options: Options & {
		readonly replace: boolean;
		readonly onStart?: (reason: "missing" | "version-mismatch") => void;
	},
) =>
	Effect.gen(function* () {
		const path = Registration.file(options.home);
		const found = yield* registered(path);
		if (found?.live !== undefined) {
			if (!options.replace || found.live.version === Identity.current.version) return endpoint(found.info);
			yield* Effect.sync(() => options.onStart?.("version-mismatch"));
			yield* terminate(path, found.info.pid);
		} else {
			// A file nothing answers for, left by a crash, must not mislead the next caller.
			if (found !== undefined && !(yield* alive(found.info.pid))) yield* remove(path);
			yield* Effect.sync(() => options.onStart?.("missing"));
		}
		return yield* start(path, options);
	});

/** The registered server once it answers, polled every 200ms for up to `timeout`. */
const ready = (path: string, timeout: Duration.Input, pending: Effect.Effect<boolean>) =>
	Effect.gen(function* () {
		const next = yield* registered(path);
		if (next?.live !== undefined) return Option.some(endpoint(next.info));
		// A live registrant that does not answer yet is another caller's server starting up.
		const waiting = (yield* pending) || (next !== undefined && (yield* alive(next.info.pid)));
		return waiting ? Option.none() : yield* Effect.fail("exited" as const);
	}).pipe(
		Effect.repeat({ until: Option.isSome, schedule: Schedule.spaced("200 millis") }),
		Effect.timeoutOption(timeout),
		Effect.map(Option.flatten),
		Effect.orElseSucceed(() => Option.none<Endpoint>()),
	);

/**
 * Start a background server and wait for it to register, quoting the reason
 * from its log when it cannot.
 *
 * The contender stays tied to this scope until it is the server adopted: a
 * timeout, an interrupt, or another caller winning the race stops it rather than
 * leaving an unmanaged server behind.
 */
const start = (path: string, options: Options) =>
	Effect.gen(function* () {
		const contender = yield* spawn(options);
		const won = yield* ready(path, START_TIMEOUT, contender.isRunning.pipe(Effect.orElseSucceed(() => false)));
		// A contender that lost the bind race exits before the winner may have filed its
		// registration; give the winner a moment before calling the start a failure.
		const server = Option.isSome(won) ? won : yield* ready(path, RACE_GRACE, Effect.succeed(true));
		if (Option.isSome(server)) {
			if (server.value.pid === contender.pid) yield* contender.unref.pipe(Effect.asVoid);
			return server.value;
		}

		const log = Registration.log(options.log);
		const reason = yield* lastLine(log);
		return yield* new ServerStartError({
			message: [
				`could not start a CodeWork server on ${options.host}:${options.port}`,
				...(reason === undefined ? [] : [`reason: ${reason}`]),
				`log: ${log}`,
				"hint: pass --port to use another port, or point `codework tui --server` at a running server",
			].join("\n"),
		});
	}).pipe(Effect.scoped);

/**
 * Keep the session's server running for as long as the caller lives.
 *
 * The TUI only reconnects; it cannot start a server. If the one it uses goes
 * away, this brings one back on the same port so the reconnect lands. It never
 * replaces a running server: another invocation may have just upgraded it.
 */
export const keepAlive = (initial: Endpoint, options: Options) =>
	Effect.gen(function* () {
		const current = yield* Ref.make(initial);
		yield* Effect.gen(function* () {
			const server = yield* Ref.get(current);
			if (yield* alive(server.pid)) return;
			const next = yield* ensure({ ...options, port: server.port, replace: false }).pipe(
				Effect.orElseSucceed(() => server),
			);
			yield* Ref.set(current, next);
		}).pipe(Effect.repeat(Schedule.spaced("1 second")));
	});

/** Ask `pid` to shut down, escalating to SIGKILL, and retire its registration. */
const terminate = (path: string, pid: number) =>
	Effect.gen(function* () {
		const signal = (name: NodeJS.Signals) => Effect.try(() => process.kill(pid, name)).pipe(Effect.ignore);
		yield* signal("SIGTERM");
		if (!(yield* exits(pid, STOP_TIMEOUT))) {
			yield* signal("SIGKILL");
			yield* exits(pid, STOP_TIMEOUT);
		}
		// A server removes its own file on a clean exit; this covers the SIGKILL path.
		const info = yield* read(path);
		if (info?.pid === pid) yield* remove(path);
	});

const lastLine = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const text = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
		return text
			.split("\n")
			.map((line) => line.trim())
			.findLast((line) => line.length > 0);
	});

/**
 * Spawn `codework serve --service` detached, inheriting this environment so it
 * resolves the same home, catalog and credentials. It writes its own log, so no
 * stdio is tied to this short-lived caller. It stays referenced, and so stopped
 * with the scope, until `start` adopts it.
 */
const spawn = (options: Options) =>
	Effect.gen(function* () {
		const [file, ...base] = Registration.command();
		if (file === undefined) return yield* Effect.die(new Error("could not resolve the codework entrypoint"));
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const handle = yield* spawner.spawn(
			ChildProcess.make(
				file,
				[...base, ...options.args, "serve", "--service", "--host", options.host, "--port", String(options.port)],
				{ detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
			),
		);
		return handle;
	});

export * as Discovery from "./discovery.ts";
