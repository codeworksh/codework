import { Effect, Option } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Runtime } from "../../../framework/runtime.ts";
import { Discovery } from "../../../server/discovery.ts";
import { Health } from "../../../server/health.ts";
import { Identity } from "../../../server/identity.ts";
import { InvalidInputError, renderError } from "../../error.ts";
import { writeError } from "../../output.ts";
import { Service } from "../../service.ts";
import { Cmd } from "../cmd.ts";

/**
 * Adopt a server the user started, only if it answers `server.info`: the UI must
 * never launch against an endpoint that is not a CodeWork server. A different
 * build is allowed, with a warning, because the user chose it.
 */
const attach = (url: string) =>
	Effect.gen(function* () {
		const info = yield* Health.probe(url);
		if (info === undefined) return yield* new InvalidInputError({ message: `no CodeWork server answered at ${url}` });
		if (info.version !== Identity.current.version) {
			yield* Effect.sync(() =>
				process.stderr.write(
					`warning: server at ${url} runs ${info.version}; this client is ${Identity.current.version}\n`,
				),
			);
		}
		return url;
	});

/** Start or reuse the local server, and keep it up while the TUI runs. */
const managed = (options: Discovery.Options) =>
	Effect.gen(function* () {
		const resolved = yield* Discovery.ensure({
			...options,
			// An upgraded CLI must not drive a server from an older build.
			replace: true,
			onStart: (reason) =>
				void process.stderr.write(
					reason === "version-mismatch"
						? "Restarting CodeWork server (version mismatch)...\n"
						: `Starting CodeWork server on ${options.host}:${options.port}...\n`,
				),
		});
		// The TUI only reconnects; restoring a server that dies under it is ours to do.
		yield* Discovery.keepAlive(resolved, options).pipe(Effect.forkScoped);
		return resolved.url;
	});

/**
 * Run the TUI in the foreground, on this terminal, for as long as this command
 * runs. It stays in this process group (`detached: false`) so it keeps the
 * terminal; stdio is inherited because it draws and reads raw keys itself. The
 * scope is what ties their lifetimes: when this command is interrupted (SIGINT,
 * SIGTERM), closing it terminates the TUI rather than leaving it on the screen.
 */
const run = (binary: string, args: ReadonlyArray<string>, env: Record<string, string>) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const tui = yield* spawner.spawn(
			ChildProcess.make(binary, [...args], {
				env,
				extendEnv: true,
				detached: false,
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			}),
		);
		// A TUI killed by a signal has no exit code; it still must not read as success.
		return yield* tui.exitCode.pipe(Effect.orElseSucceed(() => 1));
	}).pipe(Effect.scoped);

export default Runtime.handler(
	Cmd.commands.tui,
	Effect.fn("CLI.tui")(function* ({ server, host, port, args }) {
		const shared = yield* Cmd.spec;

		const program = Effect.gen(function* () {
			if (Option.isSome(server) && [shared.home, shared.database, shared.userConfigDir].some(Option.isSome)) {
				return yield* new InvalidInputError({
					message: "--home, --database, and --user-config-dir belong on codework serve when using --server",
				});
			}

			const options = yield* Service.options(shared, { host, port });
			const url = yield* Option.isSome(server) ? attach(server.value) : managed(options);

			// Imported lazily: binary resolution must stay off the path of every other command.
			const launcher = yield* Effect.promise(() => import("@codeworksh/tui"));
			const binary = yield* Effect.try({
				try: () => launcher.resolveBinary(),
				catch: (error) => new InvalidInputError({ message: (error as Error).message }),
			});
			return yield* run(binary, args, {
				[launcher.ENV_SERVER]: url,
				// The TUI reads its own config and credentials, so it must resolve the same home
				// the server uses; otherwise the UI would show a different installation.
				CODEWORK_HOME_DIR: options.home,
			});
		});

		const code = yield* program.pipe(
			Effect.scoped,
			Effect.catch((error) => writeError(renderError(error)).pipe(Effect.as(1))),
		);
		yield* Effect.sync(() => {
			process.exitCode = code;
		});
	}),
);
