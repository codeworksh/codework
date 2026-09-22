import { Global } from "@codeworksh/harness/effect";
import { Effect, FileSystem, Option, Path } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { reportFailure } from "../../../error.ts";
import { writeOut } from "../../../output.ts";
import { Cmd } from "../../cmd.ts";
import {
	identify,
	matching,
	readPlugins,
	resolveTarget,
	spellings,
	withPluginsLock,
	writePlugins,
} from "./settings.ts";

export default Runtime.handler(
	Cmd.commands.plugin.commands.remove,
	Effect.fn("CLI.plugin.remove")(function* ({ package: reference, global: userWide }) {
		const program = Effect.gen(function* () {
			const shared = yield* Cmd.spec;
			const path = yield* Path.Path;
			const fs = yield* FileSystem.FileSystem;
			const paths = yield* Global.resolve(Option.isNone(shared.home) ? {} : { home: shared.home.value });
			const target = yield* resolveTarget(shared, userWide, undefined, false);
			// Removing from a directory that is not a project is a read-only no-op. In particular, it
			// must not create the marker that would make this directory shadow a real project later.
			if (!(yield* fs.exists(path.dirname(target.path)))) {
				yield* writeOut(`Plugin "${reference}" is not configured in ${target.path}\n`);
				return;
			}
			const spelled = yield* spellings(reference, path.resolve("."));
			yield* withPluginsLock(
				target.path,
				Effect.gen(function* () {
					const { source, plugins } = yield* readPlugins(target.path);
					// Both the module entry and any configuration written against it: the package it was
					// added as, the path or version it was written with, and the ID it declares all name
					// the one plugin being removed.
					const entries = yield* identify(plugins, target.path, paths.cache);
					const selected = matching(entries, spelled);
					const kept = entries.filter((entry) => !selected.has(entry)).map((entry) => entry.value);
					if (kept.length === plugins.length) {
						yield* writeOut(`Plugin "${reference}" is not configured in ${target.path}\n`);
						return;
					}
					yield* writePlugins(target.path, source, kept);
					const dropped = plugins.length - kept.length;
					yield* writeOut(
						`Removed ${dropped} ${dropped === 1 ? "entry" : "entries"} for "${reference}" from ${target.path}\n`,
					);
				}),
			);
		});

		return yield* program.pipe(Effect.catch(reportFailure));
	}),
);
