import { Plugin } from "@codeworksh/harness/effect";
import { Effect, Schema } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { reportFailure } from "../../../error.ts";
import { writeOut } from "../../../output.ts";
import { Cmd } from "../../cmd.ts";
import { read } from "./entries.ts";

/**
 * Two columns: what was written, and what it turned out to be.
 *
 * **The second column doubles as the state, for free.** An ID cannot be known without importing
 * the module -- the store records nothing about the plugin inside a package -- so printing one is
 * proof that everything worked: the entry parsed, the store had it, the import succeeded, and the
 * definition validated. When any of that fails there is no ID to print, and the reason goes in its
 * place.
 *
 * **Nothing is stored to make that work.** The reason is the live error from this run, not a
 * record of an older one: a stored failure goes stale the moment someone fixes the cause, and a
 * list still printing `plugin-import-failed` after you installed the missing dependency is worse
 * than one that says nothing. The work is cheap and local -- a parse, a lookup and an import.
 *
 * (`checkedAt`/`outdated` are stored, for the opposite reason: those come from the network, so
 * re-obtaining them is expensive and a slightly stale answer is the right trade. Local facts are
 * recomputed; remote facts are cached.)
 */
const isSourceError = Schema.is(Plugin.SourceError);
const isInstallError = Schema.is(Plugin.InstallError);
const isStoreError = Schema.is(Plugin.StoreError);
const isLoadError = Schema.is(Plugin.LoadError);

/** The §5.5 reason slug, which is the same string the CLI prints and a log line carries. */
const reasonOf = (error: unknown): { readonly reason: string; readonly message: string } =>
	isSourceError(error) || isInstallError(error) || isStoreError(error) || isLoadError(error)
		? { reason: error.reason, message: error.message }
		: { reason: "plugin-load-failed", message: String(error) };

export default Runtime.handler(
	Cmd.commands.plugin.commands.list,
	Effect.fn("CLI.plugin.list")(function* ({ verbose }) {
		const program = Effect.gen(function* () {
			const shared = yield* Cmd.spec;
			const { entries, cache } = yield* read(shared);
			if (entries.length === 0) {
				yield* writeOut("No plugins are configured.\n");
				return;
			}

			const rows: Array<{ written: string; file: string; state: string; detail?: string }> = [];
			for (const entry of entries) {
				// Resolve-only: listing what is configured must never install anything.
				const inspected = yield* Plugin.inspect(entry.reference, {
					cache,
					hostDir: entry.from,
					file: entry.file,
					install: Plugin.resolveCached,
				}).pipe(Effect.result);
				rows.push(
					inspected._tag === "Success"
						? { written: entry.written, file: entry.file, state: inspected.success.id }
						: {
								written: entry.written,
								file: entry.file,
								state: reasonOf(inspected.failure).reason,
								detail: reasonOf(inspected.failure).message,
							},
				);
			}

			// The left column is the reference exactly as the entry spells it, because that is the
			// string a person will search their settings for.
			const width = Math.max(...rows.map((row) => row.written.length));
			for (const row of rows) {
				yield* writeOut(`${row.written.padEnd(width)}  ${row.state}\n`);
				if (verbose) {
					if (row.detail !== undefined) yield* writeOut(`${" ".repeat(width)}  ${row.detail}\n`);
					yield* writeOut(`${" ".repeat(width)}  declared in: ${row.file}\n`);
				}
			}
		});

		return yield* program.pipe(Effect.catch(reportFailure));
	}),
);
