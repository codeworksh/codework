import { Global, Plugin } from "@codeworksh/harness/effect";
import { Effect, Option, Path } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { reportFailure } from "../../../error.ts";
import { writeOut } from "../../../output.ts";
import { Cmd } from "../../cmd.ts";
import { identify, matches, readPlugins, resolveTarget, writePlugins } from "./settings.ts";

export default Runtime.handler(
	Cmd.commands.plugin.commands.add,
	Effect.fn("CLI.plugin.add")(function* ({ package: reference, global: userWide }) {
		const program = Effect.gen(function* () {
			const shared = yield* Cmd.spec;
			const path = yield* Path.Path;
			const paths = yield* Global.resolve(Option.isNone(shared.home) ? {} : { home: shared.home.value });

			// Install and import before touching the file: a spec that turns out not to be a plugin
			// should fail here, with its own error, rather than at the next run from a file the user
			// then has to repair by hand.
			const plugin = yield* Plugin.inspect(reference, { cache: paths.cache, hostCwd: path.resolve(".") });

			const target = yield* resolveTarget(shared, userWide);
			const { source, plugins } = yield* readPlugins(target.path);
			const entries = yield* identify(plugins, target.path, paths.cache);
			// Configured already if any spelling of an existing entry names this plugin -- the same
			// package under a different version, the path it was added by, or the ID it declares. A
			// `{ plugin }` and `{ package }` entries only configure an existing loader, so neither
			// can satisfy `add` alone.
			const names = (entry: (typeof entries)[number]) =>
				matches(entry, reference, path.resolve(".")) || entry.answers.has(plugin.id);
			const version = plugin.version === undefined ? "" : `@${plugin.version}`;

			// A loader for this plugin is already there. Adding it under a different spelling -- a
			// new version, or the path instead of the package -- is a request to load that one
			// instead, so the entry is rewritten in place rather than duplicated: two loaders for
			// one plugin is a state the harness resolves by discarding the first, which is exactly
			// the confusion the user was trying to avoid by running `add` again.
			const existing = entries.findIndex((entry) => entry.loads && names(entry));
			if (existing >= 0) {
				const current = entries[existing]?.value;
				if (current === reference) {
					yield* writeOut(`Plugin "${reference}" is already configured in ${target.path}\n`);
					return;
				}
				const replaced = [...plugins];
				replaced[existing] = reference;
				yield* writePlugins(target.path, source, replaced);
				yield* writeOut(`Updated ${plugin.id} (${String(current)} -> ${reference}${version}) in ${target.path}\n`);
				return;
			}

			// Put the loader before existing configuration so its options apply to the module.
			const configured = entries.findIndex((entry) => !entry.loads && names(entry));
			const updated = [...plugins];
			updated.splice(configured < 0 ? updated.length : configured, 0, reference);
			yield* writePlugins(target.path, source, updated);

			yield* writeOut(`Added ${plugin.id} (${reference}${version}) to ${target.path}\n`);
		});

		return yield* program.pipe(Effect.catch(reportFailure));
	}),
);
