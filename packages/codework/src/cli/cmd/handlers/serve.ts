import { Global } from "@codeworksh/harness/effect";
import { Effect, FileSystem, Layer, Logger } from "effect";
import { Runtime } from "../../../framework/runtime.ts";
import { Registration } from "../../../server/registration.ts";
import { Server } from "../../../server/server.ts";
import { renderError } from "../../error.ts";
import { harnessOptions } from "../../harness.ts";
import { writeError } from "../../output.ts";
import { Cmd } from "../cmd.ts";

const failed = Effect.sync(() => {
	process.exitCode = 1;
});

const report = (error: unknown) => writeError(renderError(error)).pipe(Effect.andThen(failed));

export default Runtime.handler(
	Cmd.commands.serve,
	Effect.fn("CLI.serve", { level: "Info" })(function* ({ host, port, service }) {
		const shared = yield* Cmd.spec;
		const harness = { ...harnessOptions(shared), watchModels: true };
		const serve = Layer.launch(Server.layer({ host, port, harness }));
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
