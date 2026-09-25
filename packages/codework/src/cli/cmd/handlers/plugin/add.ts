import { Global, Plugin } from "@codeworksh/harness/effect";
import { Effect, Option, Path } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { reportFailure } from "../../../error.ts";
import { writeOut } from "../../../output.ts";
import { Cmd } from "../../cmd.ts";
import { linkedDirectory } from "./session.ts";
import {
	identify,
	matches,
	readPlugins,
	resolveTarget,
	spellings,
	withPluginsLock,
	writePlugins,
	written,
} from "./settings.ts";

export default Runtime.handler(
	Cmd.commands.plugin.commands.add,
	Effect.fn("CLI.plugin.add")(function* ({ package: reference, global: userWide, session }) {
		const program = Effect.gen(function* () {
			const shared = yield* Cmd.spec;
			const path = yield* Path.Path;
			const paths = yield* Global.resolve(Option.isNone(shared.home) ? {} : { home: shared.home.value });

			// A session names the project to write into when the shell's directory is not it --
			// a server or a UI acting on a session's behalf, rather than a person standing in the
			// repository. It fails when that session has no project, which is a state `session
			// link` exists to fix.
			const linked = Option.isNone(session) ? undefined : yield* linkedDirectory(session.value, shared.home);
			/*
			 * One directory answers every question this command asks about the reference, and it
			 * is resolved before any of them.
			 *
			 * A relative spec anchors here, the `.npmrc` chain governing the install is read from
			 * here, and the entry is written anchored here. Splitting them is not a cosmetic
			 * inconsistency: under `--session` the shell's directory is a server's, so validating
			 * `./plugins/x.ts` against it imports one file and writes a reference to another, and
			 * reading the `.npmrc` chain from it installs from the wrong registry -- a private
			 * scope's token lives in the project being written to, not wherever the server runs.
			 */
			const from = linked ?? path.resolve(".");

			// The file the entry will land in decides the install's registry identity: it is named
			// here -- without creating the marker -- so the store keys the artifact under the same
			// `.npmrc` chain every later resolve of this entry re-derives, and a bad reference
			// still leaves nothing behind.
			const target = yield* resolveTarget(shared, userWide, linked, false);

			// Install and import before touching the file: a spec that turns out not to be a plugin
			// should fail here, with its own error, rather than at the next run from a file the user
			// then has to repair by hand.
			const plugin = yield* Plugin.inspect(reference, { cache: paths.cache, hostDir: from, file: target.path });
			// What goes in the file, which is not always what was typed: a relative path anchors to
			// the settings file being written, not to the directory the command ran in.
			const entry = yield* written(reference, {
				hostDir: from,
				file: target.path,
				root: target.root,
			});
			const spelled = yield* spellings(reference, from);
			const version = plugin.version === undefined ? "" : `@${plugin.version}`;
			yield* withPluginsLock(
				target.path,
				Effect.gen(function* () {
					const { source, plugins } = yield* readPlugins(target.path);
					const entries = yield* identify(plugins, target.path, paths.cache);
					// Configured already if any spelling of an existing entry names this plugin -- the same
					// package under a different version, the path it was added by, or the ID it declares.
					const names = (candidate: (typeof entries)[number]) =>
						matches(candidate, spelled) || candidate.answers.has(plugin.id);
					const existing = entries.findIndex((candidate) => candidate.loads && names(candidate));
					if (existing >= 0) {
						const current = entries[existing]?.value;
						if (current === entry) {
							yield* writeOut(`Plugin "${reference}" is already configured in ${target.path}\n`);
							return;
						}
						const replaced = [...plugins];
						replaced[existing] = entry;
						yield* writePlugins(target.path, source, replaced);
						yield* writeOut(
							`Updated ${plugin.id} (${String(current)} -> ${entry}${version}) in ${target.path}\n`,
						);
						return;
					}

					// Put the loader before existing configuration so its options apply to the module.
					const configured = entries.findIndex((candidate) => !candidate.loads && names(candidate));
					const updated = [...plugins];
					updated.splice(configured < 0 ? updated.length : configured, 0, entry);
					yield* writePlugins(target.path, source, updated);
					yield* writeOut(`Added ${plugin.id} (${entry}${version}) to ${target.path}\n`);
				}),
			);
			// Said after the write, because `resolveTarget` only named the marker: the lock's
			// write is what made it, and "created" should be true by the time it is printed.
			if (target.created !== undefined) yield* writeOut(`Created ${target.created}/\n`);
		});

		return yield* program.pipe(Effect.catch(reportFailure));
	}),
);
