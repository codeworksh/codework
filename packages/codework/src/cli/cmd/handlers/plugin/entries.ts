import { Global, Plugin, Settings } from "@codeworksh/harness/effect";
import { Effect, Option, Path } from "effect";
import { writeOut } from "../../../output.ts";
import type { Shared } from "./settings.ts";

/**
 * Every plugin entry the settings files name, across every layer, in the order they accumulate.
 *
 * This is what `install`, `list`, `check` and `update` all operate on: unlike `add` and `remove`,
 * none of them writes an entry. They read what is already there and act on the store -- each one
 * under the `.npmrc` context of the file that declared it, which is what keys the artifact.
 */
export interface Entry {
	/** The reference as the settings file spells it: the string a person will search for. */
	readonly written: string;
	/** The same reference, anchored to the file that declared it. This is what resolves. */
	readonly reference: string;
	/** Which settings file owns it: the last to declare it in the view that needs it. */
	readonly file: string;
	/**
	 * The `.npmrc` anchor for the entry's store identity: the project that declared it, so the
	 * registry context is the same wherever this command happens to run.
	 */
	readonly from: string;
	/** Absent for an unparseable entry and for a local path. */
	readonly target: Plugin.Target | undefined;
}

/** Only a string entry loads a module; `{ package }` is configuration for one already selected. */
const moduleOf = (entry: unknown): string | undefined => (typeof entry === "string" ? entry : undefined);

export const read = Effect.fn("CLI.plugin.entries")(function* (shared: Shared) {
	const nodePath = yield* Path.Path;
	// No session links this command to a host directory, so the one it runs in is its anchor:
	// project settings are discovered from here, and a relative spec typed here resolves here.
	const hostDir = nodePath.resolve(".");
	const paths = yield* Global.resolve(Option.isNone(shared.home) ? {} : { home: shared.home.value });
	const root = yield* Settings.projectRoot(hostDir, paths.home);
	const layers = {
		home: paths.home,
		...(Option.isNone(shared.userConfigDir) ? {} : { userConfigDir: shared.userConfigDir.value }),
	};
	/*
	 * The runtime resolves plugins in two views, and each needs its own artifact on disk: boot
	 * reads the user layers alone, and a session reads every layer. Within a view the last file to
	 * declare a reference owns it, so a spec both layers name is owned by the user file at boot and
	 * by the project file in the project's sessions -- two `.npmrc` anchors, and possibly two
	 * registries. Collapsing it to one owner leaves one of those views without its artifact.
	 */
	const boot = yield* Settings.load(layers);
	const views = root === undefined ? [boot] : [boot, yield* Settings.load({ ...layers, hostDir: root })];

	// One entry per store artifact, so two anchors on one registry stay a single line. A later
	// view names the file, which is the one a person in this project would edit.
	const entries = new Map<string, Entry>();
	for (const view of views) {
		for (const [reference, one] of Settings.modules(view.declared)) {
			// Already anchored to the file that declared it, so `hostDir` here only affects a
			// reference no settings file produced.
			const target = Option.getOrUndefined(yield* Plugin.parse(reference, hostDir).pipe(Effect.option));
			const from = Plugin.anchor(one.file, hostDir);
			const key = yield* identity(target, reference, from, paths.cache);
			entries.set(key, { written: moduleOf(one.written) ?? reference, reference, file: one.file, from, target });
		}
	}
	return { entries: [...entries.values()] as ReadonlyArray<Entry>, cache: paths.cache, hostDir };
});

/**
 * What makes two entries one artifact: the store's own key for a fetched target, the file for a
 * local one. A registry that cannot be read keeps the entry apart, so its install reports why.
 */
const identity = (target: Plugin.Target | undefined, reference: string, from: string, cache: string) => {
	const fetched = fetchable(target);
	if (fetched === undefined) return Effect.succeed(target?.kind === "local" ? target.path : reference);
	return Plugin.identity(fetched, cache, from).pipe(Effect.orElseSucceed(() => `${reference}\0${from}`));
};

/** What a reference names, whatever version it was written with: a package, a git spec, a file. */
const source = (reference: string, hostDir: string) =>
	Plugin.canonical(reference, hostDir).pipe(Effect.orElseSucceed(() => reference));

/**
 * The entries a command acts on: all of them, or every one `spec` names.
 *
 * Matched by source identity, the way the `plugins` array reads -- `@acme/x` selects
 * `@acme/x@^1`, a relative path selects the file it resolves to from `hostDir`, and a local package
 * also answers to the name its `package.json` declares. A plugin ID is not a spelling of anything
 * in that array, so it matches nothing. Every match is kept: a spec both layers declare under
 * different registries is two artifacts, and both answer to it.
 */
export const targeted = Effect.fn("CLI.plugin.targeted")(function* (
	entries: ReadonlyArray<Entry>,
	spec: Option.Option<string>,
	/** The host directory the command resolves from, which a relative spec is typed against. */
	hostDir: string,
) {
	if (Option.isNone(spec)) return entries;
	const wanted = yield* source(spec.value, hostDir);
	const selected: Entry[] = [];
	for (const entry of entries) {
		const named =
			(yield* source(entry.reference, hostDir)) === wanted ||
			(entry.target?.kind === "local" && (yield* Plugin.localName(entry.target.path)) === wanted);
		if (named) selected.push(entry);
	}
	if (selected.length === 0) {
		yield* writeOut(`Plugin "${spec.value}" is not configured. Run \`codework plugin list\` to see what is.\n`);
		process.exitCode = 1;
	}
	return selected as ReadonlyArray<Entry>;
});

/**
 * A local plugin has no revision to compare and is never copied into the store. Skipped quietly
 * when a command walks everything; named, it says why nothing happened.
 */
export const local = (entry: Entry, spec: Option.Option<string>) =>
	Option.isSome(spec) ? writeOut(`${entry.reference}  local: no remote revision to compare\n`) : Effect.void;

/**
 * The network half, handed to the store so the store itself never opens a socket.
 *
 * `probe` bypasses pacote's own metadata cache, because a staleness check that reads a cache is
 * not a staleness check. `from` is the host directory: a probe that read a different `.npmrc`
 * chain than the install would answer about a registry nothing is ever fetched from.
 */
export const probe =
	(cache: string, from: string): Plugin.Probe =>
	(target) =>
		Plugin.probe(target, cache, from);

/** Only a fetched target has a store entry; a local one is loaded where it lies. */
export const fetchable = (target: Plugin.Target | undefined): Plugin.Fetchable | undefined =>
	target === undefined || target.kind === "local" ? undefined : target;
