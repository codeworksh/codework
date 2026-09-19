import { Plugin } from "@codeworksh/harness/effect";
import { Effect } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { reportFailure } from "../../../error.ts";
import { writeOut } from "../../../output.ts";
import { Cmd } from "../../cmd.ts";
import { fetchable, read } from "./entries.ts";

/**
 * `plugin install`, with no argument: the answer to a fresh checkout.
 *
 * A committed `.codework/settings.jsonc` names plugins, the store on a colleague's machine is
 * empty, and something has to materialise them. This is `npm install` with no arguments -- it
 * writes no settings entry, because the entries already exist.
 *
 * It is also what lets **boot stay offline**. Without it the only path from an entry to bytes is a
 * boot that installs, which makes every fresh start a possible network wait; with it, boot
 * resolves or reports, and the error names this command as the remedy.
 */
export default Runtime.handler(
	Cmd.commands.plugin.commands.install,
	Effect.fn("CLI.plugin.install")(function* () {
		const program = Effect.gen(function* () {
			const shared = yield* Cmd.spec;
			const { entries, cache, hostDir } = yield* read(shared);

			let installed = 0;
			let present = 0;
			let local = 0;
			for (const entry of entries) {
				const target = fetchable(entry.target);
				if (target === undefined) {
					// A local plugin is loaded where it lies and never copied into the store, so
					// there is nothing to install. An unparseable entry is `list`'s to report.
					local += 1;
					continue;
				}
				if ((yield* Plugin.resolve(target, cache)) !== undefined) {
					present += 1;
					continue;
				}
				// `inspect` installs, imports and validates, so a spec that turns out not to be a
				// plugin fails here rather than at the next run. The reported ID comes from the
				// module, never from the spec.
				const plugin = yield* Plugin.inspect(entry.reference, { cache, hostDir });
				installed += 1;
				yield* writeOut(`Installed ${entry.reference} (${plugin.id})\n`);
			}

			const parts = [
				`${installed} installed`,
				...(present === 0 ? [] : [`${present} already present`]),
				...(local === 0 ? [] : [`${local} local`]),
			];
			yield* writeOut(`${parts.join(", ")}\n`);
		});

		return yield* program.pipe(Effect.catch(reportFailure));
	}),
);
