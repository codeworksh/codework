import { Global, Settings } from "@codeworksh/harness/effect";
import { Config, Effect, FileSystem, Layer, Logger } from "effect";
import * as Runtime from "../../../framework/runtime.ts";
import * as Registration from "../../../server/registration.ts";
import * as Server from "../../../server/server.ts";
import { InvalidInputError, renderError } from "../../error.ts";
import { harnessOptions } from "../../harness.ts";
import { writeError } from "../../output.ts";
import { Cmd } from "../cmd.ts";

const failed = Effect.sync(() => {
	process.exitCode = 1;
});

const report = (error: unknown) => writeError(renderError(error)).pipe(Effect.andThen(failed));

const entries = (values: ReadonlyArray<string>) =>
	values
		.flatMap((value) => value.split(","))
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");

/**
 * The proxies `--trusted-proxy` names, else `CODEWORK_TRUSTED_PROXY`; none from either leaves the
 * user settings' `server.trustedProxy`, which settings decode themselves.
 */
const trustedProxy = Effect.fn(function* (flag: ReadonlyArray<string>) {
	const env = entries([yield* Config.String("CODEWORK_TRUSTED_PROXY").pipe(Config.withDefault(""))]);
	const [source, given] = flag.length > 0 ? ["--trusted-proxy", entries(flag)] : ["CODEWORK_TRUSTED_PROXY", env];
	if (given.length === 0) return undefined;
	return yield* Effect.forEach(given, (entry) => {
		const network = Settings.proxyNetwork(entry);
		return network === undefined
			? Effect.fail(new InvalidInputError({ message: `${source}: "${entry}" is not an IP address or CIDR range` }))
			: Effect.succeed(network);
	});
});

export default Runtime.handler(
	Cmd.commands.serve,
	Effect.fn("CLI.serve", { level: "Info" })(function* ({ host, port, service, trustedProxy: flag }) {
		const shared = yield* Cmd.spec;
		const harness = { ...harnessOptions(shared), watchModels: true };
		const serve = Effect.flatMap(trustedProxy(flag), (trusted) =>
			Layer.launch(
				Server.layer({ host, port, harness, ...(trusted === undefined ? {} : { trustedProxy: trusted }) }),
			),
		);
		if (!service) return yield* serve.pipe(Effect.catch(report));

		// A background server has no terminal: its log, and the reason it stopped, go to a
		// file the CLI that started it reads back when startup fails.
		const background = Effect.gen(function* () {
			const paths = yield* Global.resolve(harness.home === undefined ? {} : { home: harness.home });
			const fs = yield* FileSystem.FileSystem;
			yield* fs.makeDirectory(paths.log, { recursive: true });
			const logger = Logger.formatSimple.pipe(Logger.toFile(Registration.log(paths.log), { flag: "w" }));
			yield* serve.pipe(
				Effect.catch((error) => Effect.logError(renderError(error).trim()).pipe(Effect.andThen(failed))),
				Effect.provide(Logger.layer([logger])),
			);
		});
		yield* background.pipe(Effect.catch(report));
	}),
);
