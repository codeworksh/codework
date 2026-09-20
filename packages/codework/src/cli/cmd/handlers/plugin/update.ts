import { Plugin } from "@codeworksh/harness/effect";
import { Effect } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { reportFailure } from "../../../error.ts";
import { writeOut } from "../../../output.ts";
import { Cmd } from "../../cmd.ts";
import { fetchable, probe, read } from "./entries.ts";

/**
 * Take whatever `check` found.
 *
 * Only a plugin that is **already installed** is refreshed: "not installed" is not "outdated", and
 * `plugin install` is the verb for that. Each refresh publishes a new generation, which a running
 * session picks up at its next exchange -- so this command never has to reach into a server.
 */
export default Runtime.handler(
	Cmd.commands.plugin.commands.update,
	Effect.fn("CLI.plugin.update")(function* () {
		const program = Effect.gen(function* () {
			const shared = yield* Cmd.spec;
			const { entries, cache, hostDir } = yield* read(shared);

			let updated = 0;
			let failed = 0;
			for (const entry of entries) {
				const target = fetchable(entry.target);
				// A local plugin has no revision to compare and is never copied into the store.
				if (target === undefined) continue;

				const result = yield* Plugin.update(target, cache, {
					probe: probe(cache, hostDir),
					from: hostDir,
					// Validated while staged, so a refresh that fetches something broken leaves
					// the generation already in use as the answer. Preserve the loader's reason:
					// an import failure or invalid definition is not a missing entrypoint.
					validate: (fetched) => Plugin.definition(fetched.entrypoint, entry.reference).pipe(Effect.asVoid),
				}).pipe(Effect.result);

				if (result._tag === "Failure") {
					failed += 1;
					yield* writeOut(`${entry.reference}  error[${result.failure.reason}]: ${result.failure.message}\n`);
					continue;
				}
				if (result.success._tag === "updated") {
					updated += 1;
					yield* writeOut(`Updated ${entry.reference} to ${result.success.entry.revision ?? "a new revision"}\n`);
				}
			}

			yield* writeOut(updated === 0 ? "Nothing to update.\n" : `${updated} updated.\n`);
			if (failed > 0) process.exitCode = 1;
		});

		return yield* program.pipe(Effect.catch(reportFailure));
	}),
);
