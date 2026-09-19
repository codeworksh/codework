import { Global, Plugin, Settings } from "@codeworksh/harness/effect";
import { Effect, Option, Path } from "effect";
import type { Shared } from "./settings.ts";

/**
 * Every plugin entry the settings files name, across every layer, in the order they accumulate.
 *
 * This is what `install`, `list`, `check` and `update` all operate on: unlike `add` and `remove`,
 * none of them writes an entry, so none of them needs to know which file declared one. They read
 * what is already there and act on the store.
 */
export interface Entry {
	/** The reference as the settings files resolved it. */
	readonly reference: string;
	/** Absent for a plugin entry that only configures something else, and for a local path. */
	readonly target: Plugin.Target | undefined;
}

/** A settings entry names a module as a bare string or as `package`; `plugin` configures one. */
const moduleOf = (entry: unknown): string | undefined => {
	if (typeof entry === "string") return entry;
	if (typeof entry !== "object" || entry === null) return undefined;
	const value = (entry as { readonly package?: unknown }).package;
	return typeof value === "string" ? value : undefined;
};

export const read = Effect.fn("CLI.plugin.entries")(function* (shared: Shared) {
	const nodePath = yield* Path.Path;
	const cwd = nodePath.resolve(".");
	const paths = yield* Global.resolve(Option.isNone(shared.home) ? {} : { home: shared.home.value });
	const root = yield* Settings.projectRoot(cwd, paths.home);
	const config = yield* Settings.load({
		home: paths.home,
		...(root === undefined ? {} : { hostDir: root }),
		...(Option.isNone(shared.userConfigDir) ? {} : { userConfigDir: shared.userConfigDir.value }),
	});

	const seen = new Set<string>();
	const entries: Entry[] = [];
	for (const value of config.plugins) {
		const reference = moduleOf(value);
		// Loading is keyed by the module, so the same one named twice is one entry here too.
		if (reference === undefined || seen.has(reference)) continue;
		seen.add(reference);
		// `Settings.load` has already anchored a relative path to the file that declared it, so
		// `cwd` here only affects a reference no settings file produced.
		const target = yield* Plugin.parse(reference, cwd).pipe(Effect.option);
		entries.push({ reference, target: Option.getOrUndefined(target) });
	}
	return { entries: entries as ReadonlyArray<Entry>, cache: paths.cache, home: paths.home, hostDir: cwd };
});

/**
 * The network half, handed to the store so the store itself never opens a socket.
 *
 * `probe` bypasses pacote's own metadata cache, because a staleness check that reads a cache is
 * not a staleness check.
 */
export const probe =
	(cache: string): Plugin.Probe =>
	(target) =>
		Plugin.probe(target, cache);

/** Only a fetched target has a store entry; a local one is loaded where it lies. */
export const fetchable = (target: Plugin.Target | undefined): Plugin.Fetchable | undefined =>
	target === undefined || target.kind === "local" ? undefined : target;
