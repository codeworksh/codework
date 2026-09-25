import { Plugin } from "@codeworksh/harness/effect";
import { Effect, Option } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { reportFailure } from "../../../error.ts";
import { writeOut } from "../../../output.ts";
import { Cmd } from "../../cmd.ts";
import { fetchable, local, probe, read, targeted } from "./entries.ts";

/**
 * Which configured plugins have a newer revision available.
 *
 * A probe failure -- offline, registry down, a remote that refuses -- is **not** an update. It is
 * reported per target and the command exits non-zero, rather than being swallowed into "you are up
 * to date": an outage that reads as currency is the one answer this command must never give.
 */
export default Runtime.handler(
	Cmd.commands.plugin.commands.check,
	Effect.fn("CLI.plugin.check")(function* ({ refresh, spec }) {
		const program = Effect.gen(function* () {
			const shared = yield* Cmd.spec;
			const { entries, cache } = yield* read(shared);
			const selected = yield* targeted(entries, spec);
			if (selected.length === 0 && Option.isSome(spec)) return;

			let outdated = 0;
			let failed = 0;
			for (const entry of selected) {
				const target = fetchable(entry.target);
				// Nothing to compare: a local path has no revision, and `check` skips it rather
				// than reporting it as current.
				if (target === undefined) {
					yield* local(entry, spec);
					continue;
				}

				const state = yield* Plugin.check(target, cache, {
					refresh,
					probe: probe(cache, entry.from),
					from: entry.from,
				}).pipe(Effect.result);
				if (state._tag === "Failure") {
					failed += 1;
					yield* writeOut(`${entry.reference}  error[${state.failure.reason}]: ${state.failure.message}\n`);
					continue;
				}
				switch (state.success._tag) {
					case "outdated":
						outdated += 1;
						yield* writeOut(`${entry.reference}  ${state.success.filed ?? "?"} -> ${state.success.available}\n`);
						break;
					case "not-installed":
						yield* writeOut(`${entry.reference}  plugin-not-installed\n`);
						break;
					// An exact version and a commit SHA cannot move, so neither is worth a line.
					case "immutable":
					case "current":
						break;
				}
			}

			// A spec that named only local plugins compared nothing, so there is nothing to sum up.
			if (Option.isSome(spec) && selected.every((entry) => fetchable(entry.target) === undefined)) return;
			yield* writeOut(
				outdated === 0 && failed === 0
					? "Everything is up to date.\n"
					: `${outdated} update${outdated === 1 ? "" : "s"} available.\n`,
			);
			if (failed > 0) process.exitCode = 1;
		});

		return yield* program.pipe(Effect.catch(reportFailure));
	}),
);
