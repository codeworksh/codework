import { Effect, Option } from "effect";
import { Runtime } from "../../../framework/runtime.ts";
import { Discovery } from "../../../server/discovery.ts";
import { Health } from "../../../server/health.ts";
import { InvalidInputError, renderError } from "../../error.ts";
import { writeError } from "../../output.ts";
import { Cmd } from "../cmd.ts";

interface Shared {
	readonly home: Option.Option<string>;
	readonly database: Option.Option<string>;
	readonly userConfigDir: Option.Option<string>;
}

/** The server-owned flags a managed server needs, in the order `serve` parses them. */
const serverFlags = (shared: Shared): ReadonlyArray<string> => [
	...(Option.isSome(shared.home) ? ["--home", shared.home.value] : []),
	...(Option.isSome(shared.database) ? ["--database", shared.database.value] : []),
	...(Option.isSome(shared.userConfigDir) ? ["--user-config-dir", shared.userConfigDir.value] : []),
];

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

			const endpoint = yield* Option.isSome(server)
				? // A supplied server is adopted only if it answers `server.info`; the UI must
					// never launch against an endpoint that is not actually a CodeWork server.
					Health.probe(server.value).pipe(
						Effect.flatMap((info) =>
							info === undefined
								? Effect.fail(
										new InvalidInputError({ message: `no CodeWork server answered at ${server.value}` }),
									)
								: Effect.succeed(server.value),
						),
					)
				: Discovery.ensure({
						home: Discovery.home(Option.getOrUndefined(shared.home)),
						host,
						port,
						args: serverFlags(shared),
						env: process.env,
						onStart: () => void process.stderr.write(`Starting CodeWork server on ${host}:${port}...\n`),
					}).pipe(Effect.map((resolved) => resolved.url));

			// The TUI reads its own config and credentials, so it must resolve the same home
			// the managed server used; otherwise the UI would show a different installation.
			const env: NodeJS.ProcessEnv = { ...process.env };
			if (Option.isSome(shared.home)) env["CODEWORK_HOME_DIR"] = shared.home.value;

			// Imported lazily: the launcher must stay off the path of every other command.
			const launcher = yield* Effect.promise(() => import("@codeworksh/tui"));
			const forwarded: ReadonlyArray<string> = args;
			return yield* Effect.promise(() => launcher.launch({ server: endpoint, args: forwarded, env }));
		});

		const code = yield* program.pipe(Effect.catch((error) => writeError(renderError(error)).pipe(Effect.as(1))));
		yield* Effect.sync(() => {
			process.exitCode = code;
		});
	}),
);
