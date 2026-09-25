import { Effect, Layer, Option, Ref } from "effect";
import { Context } from "../context/context.ts";
import { Control } from "../control.ts";
import { Database } from "../db/db.ts";
import { Event } from "../event/event.ts";
import { EventRegistry } from "../event/registry.ts";
import { Global } from "../global.ts";
import { fileSystem, hostPath } from "../host.ts";
import { ModelCatalog } from "../model/catalog.ts";
import { builtins } from "../plugin/builtin.ts";
import { follow, load, type Origin, type PluginRef, type Pool } from "../plugin/catalog.ts";
import { anchor } from "../plugin/loader.ts";
import { PluginSource } from "../plugin/source.ts";
import { PluginStore } from "../plugin/store.ts";
import { RunnerExecute } from "../runner/execute.ts";
import { LLM } from "../runner/llm.ts";
import { Loop } from "../runner/loop.ts";
import { SandboxController } from "../sandbox/control.ts";
import { SandboxDriver } from "../sandbox/driver.ts";
import { MemorySandboxDriver } from "../sandbox/drivers/memory.ts";
import { SqldbSandboxDriver } from "../sandbox/drivers/sqldb.ts";
import { SandboxDriverLoader } from "../sandbox/loader.ts";
import { SandboxDriverRegistry } from "../sandbox/registry.ts";
import { SessionLive } from "../session/live.ts";
import { SessionRuntime } from "../session/runtime.ts";
import type { Info as SettingsInfo } from "../settings/schema.ts";
import { Settings } from "../settings/settings.ts";
import { State } from "../state/state.ts";
import { expandTilde } from "../util/home.ts";

export interface Options {
	/**
	 * The complete selection, replacing both the built-ins and whatever `settings.plugins`
	 * asks for -- an embedder that passes this owns the plugin set, and an empty array runs
	 * none. Omit it to get the built-ins plus the settings block.
	 */
	readonly plugins?: ReadonlyArray<PluginRef>;
	readonly database?: string;
	/**
	 * The process-level host directory: the default sandbox mount, the `.npmrc`/parse fallback
	 * for plugin references no file declared, and the base a relative `--user-config-dir`
	 * resolves against. Defaults to the OS process's directory. It is never a project-settings
	 * root -- that discovery belongs to a session's `hostDir`.
	 */
	readonly hostCwd?: string;
	readonly home?: string;
	/** user provided directory containing the highest-priority config. */
	readonly userConfigDir?: string;
	readonly sandboxes?: ReadonlyArray<SandboxDriverLoader.Entry>;
	readonly llm?: LLM.Open;
	/**
	 * Keep `<home>/models.gen.json` fresh for the life of the process, as a server does.
	 * Otherwise it is checked once, at boot.
	 */
	readonly watchModels?: boolean;
}

export const layer = (options: Options = {}) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const paths = yield* Global.resolve(options.home === undefined ? {} : { home: options.home });
			// The single sanctioned `process.cwd()` in the harness, and only as the default.
			// Everything downstream takes the host directory as a required parameter, so no module
			// can quietly fall back to the OS process's directory when it meant a session's mount.
			const hostCwd = options.hostCwd ?? process.cwd();
			const global = Global.layerWith(paths);
			// `--user-config-dir` is a process-level flag: `~` expands to the user's home, and a
			// relative spelling resolves against the process's own directory. A session's
			// `hostDir` has no claim on it.
			const settingsOptions =
				options.userConfigDir === undefined
					? {}
					: { userConfigDir: hostPath.resolve(hostCwd, expandTilde(options.userConfigDir, hostPath)) };
			// Settings are read once here because the plugin selection has to be prepared before
			// any layer that depends on it; every later read goes through `Settings.Service`.
			//
			// No `hostDir` is passed: that parameter is a property of a session, and a process
			// has none. Boot reads the user layer and the explicit override only -- a server can
			// start anywhere, so it must never walk ancestors of the directory it happened to
			// launch in for a `.codework/`, which would hand it a stranger's project settings.
			// A project's plugins still load: lazily, at the session's first exchange, through
			// `follow`.
			const config = yield* Settings.load({ ...settingsOptions, home: paths.home });
			/*
			 * Which entries this process configures from, per exchange.
			 *
			 * Settings entries extend the built-in selection rather than standing in for it, so
			 * naming a plugin cannot silently drop Bash or the default prompt. A built-in is turned
			 * off by name, with a `{ "plugin": "codework.tool.bash", "enabled": false }` entry.
			 *
			 * An embedder that supplied its own list keeps it verbatim: it asked for exactly this
			 * selection, and the files must not add to it behind its back.
			 */
			const references = (settings: SettingsInfo): ReadonlyArray<PluginRef> =>
				options.plugins ?? [...builtins, ...settings.plugins];

			/** Reference to the file that owns it: the `.npmrc` anchor, and what a failure names. */
			const declaredIn = (settings: SettingsInfo): ReadonlyMap<string, string> =>
				new Map(Array.from(Settings.modules(settings.declared), ([reference, one]) => [reference, one.file]));

			const catalogOptions = { builtins, cache: paths.cache, hostDir: hostCwd };

			/*
			 * What the store already holds for a reference, and nothing else.
			 *
			 * Resolve-only by construction: `Store.resolve` never opens a socket, so an exchange
			 * asking this question cannot block on a registry, and `plugin install` stays the only
			 * verb that puts bytes on disk. A reference that does not parse, or names a local
			 * path, is simply not filed.
			 */
			type Here = Option.Option<{ readonly generation?: number }>;
			const filed = (reference: string, from: string): Effect.Effect<Here> =>
				PluginSource.parse(reference, hostCwd).pipe(
					Effect.flatMap((target): Effect.Effect<Here, unknown> =>
						target.kind === "local"
							? // On disk by definition, so it can be loaded now -- but never filed, so it
								// has no generation and can never be found superseded. That is what
								// leaves `reload` as the only way to pick up an edit to one.
								fileSystem
									.exists(target.path)
									.pipe(Effect.map((there): Here => (there ? Option.some({}) : Option.none())))
							: PluginStore.resolve(target, paths.cache, from).pipe(
									Effect.map((entry): Here => Option.fromUndefinedOr(entry)),
								),
					),
					Effect.orElseSucceed((): Here => Option.none()),
				);

			/*
			 * Resolve-only, everywhere the harness loads.
			 *
			 * Boot included, and that is the point: an entry whose bytes are missing is reported
			 * as `plugin-not-installed` with `codework plugin install` as the remedy, rather than
			 * silently becoming a registry round-trip on every start. Otherwise a fresh process
			 * can wait on the network, fail offline, and let network timing decide which code
			 * runs. Freshness is opt-in -- `plugin install`, `check`, `update` -- and this is what
			 * makes that true rather than aspirational.
			 */
			const resolveOnly = { ...catalogOptions, install: PluginStore.required };

			// The load pass, once, at boot: a store lookup and an ESM import per module, never a
			// fetch. Every later exchange runs only the config pass over what this produced.
			const pool = yield* Ref.make<Pool>(
				yield* load(references(config), { ...resolveOnly, declared: declaredIn(config) }),
			);
			const followStore = (refs: ReadonlyArray<PluginRef>, current: Pool, settings: SettingsInfo) =>
				follow(refs, current, { ...resolveOnly, declared: declaredIn(settings) }, filed);

			/*
			 * A reload re-imports everything, including the local plugins nothing else can notice
			 * have changed. The counter is what makes that possible: a local plugin's URL never
			 * moves, so without a query string the module registry would hand back what it already
			 * has. Resolve-only, like the boundary check -- reload re-reads disk, it never fetches.
			 */
			/** A session's view is its project root; one with no project runs from the process view. */
			const viewOf = (hostDir: string | undefined) =>
				hostDir === undefined
					? Effect.undefined
					: Settings.projectRoot(hostDir, paths.home).pipe(Effect.orElseSucceed(() => undefined));

			let reloads = 0;
			const rebuild = (root: string | undefined, loaded: Pool) =>
				Effect.gen(function* () {
					reloads += 1;
					// Re-read the view's layers: for the process view the user layer and the
					// explicit override, as at boot; for a project, those plus the project's own.
					// A project root is only ever one a session already led here -- never the
					// result of a process-level discovery walk.
					const current = yield* Settings.load({
						...settingsOptions,
						home: paths.home,
						...(root === undefined ? {} : { hostDir: root }),
					});
					// Include modules the view's sessions discovered lazily, not only what its
					// settings name today. The current declarations come last so an edited spec
					// replaces an older origin with the same plugin ID while other plugins remain.
					//
					// `follow` applies the same rule: a retained origin whose source has vanished
					// since it loaded drops out of the reload with a warning instead of failing it
					// -- otherwise one deleted file would keep every later rebuild from succeeding.
					const retained: Origin[] = [];
					const configured = references(current);
					for (const origin of loaded.origins.values()) {
						if (
							configured.includes(origin.reference) ||
							Option.isSome(yield* filed(origin.reference, anchor(origin.file, hostCwd)))
						) {
							retained.push(origin);
							continue;
						}
						yield* Effect.logWarning(
							`plugin ${origin.reference} no longer resolves; it is dropped from the loaded set`,
						);
					}
					const accumulated = [...Array.from(retained, (origin) => origin.reference), ...configured];
					// A retained module re-resolves under the registry its declaring file named, so
					// the reload finds the entry `plugin install` filed for it. The current
					// declarations win where both name one reference.
					const known = new Map<string, string>();
					for (const origin of retained) {
						if (origin.file !== undefined) known.set(origin.reference, origin.file);
					}
					for (const [reference, file] of declaredIn(current)) known.set(reference, file);
					return yield* load(accumulated, {
						...resolveOnly,
						declared: known,
						reload: reloads,
					});
				});
			// Flattened before anything can publish: a plugin event type that collides
			// or is not namespaced is a boot failure, not a surprise at first publish.
			const definitions = yield* EventRegistry.flatten([...(yield* Ref.get(pool)).plugins.values()]);
			const configuredDatabase = options.database ?? (yield* Database.locationConfig);
			const database = Database.layer(Database.resolveDatabaseLocation(configuredDatabase, paths.data));
			const configured = yield* SandboxDriverLoader.loadAll(options.sandboxes ?? [], { hostCwd });
			const drivers = SandboxDriverRegistry.layer(
				SandboxDriver.withSource(MemorySandboxDriver.make().driver, "core"),
				SandboxDriver.withSource(SqldbSandboxDriver.make().driver, "core"),
				...configured,
			);
			const sandboxes = SandboxController.layer({ hostCwd }).pipe(
				Layer.provideMerge(drivers),
				Layer.provideMerge(database),
			);
			const authFile = Global.authFile(options.home === undefined ? undefined : paths.home);
			const open = options.llm ?? LLM.openWith(authFile === undefined ? {} : { authFile });
			const loop = Loop.layer({ request: LLM.make(open) });

			return Control.layer.pipe(
				Layer.provideMerge(RunnerExecute.layer.pipe(Layer.provide(loop))),
				Layer.provideMerge(State.layer({}, pool, references, followStore, rebuild, viewOf)),
				Layer.provideMerge(Settings.layer(settingsOptions)),
				Layer.provideMerge(SessionRuntime.layer),
				Layer.provideMerge(sandboxes),
				Layer.provideMerge(Context.layer),
				Layer.provideMerge(SessionLive.layer),
				Layer.provideMerge(Event.layer),
				Layer.provideMerge(EventRegistry.layer(definitions)),
				Layer.provideMerge(database),
				Layer.provideMerge(global),
				Layer.provideMerge(ModelCatalog.layer({ home: paths.home, watch: options.watchModels ?? false })),
			);
		}),
	);

export * as Harness from "./harness.ts";
